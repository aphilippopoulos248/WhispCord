package dev.saseq.whispcord;

import net.dv8tion.jda.api.JDA;
import net.dv8tion.jda.api.Permission;
import net.dv8tion.jda.api.components.label.Label;
import net.dv8tion.jda.api.components.textinput.TextInput;
import net.dv8tion.jda.api.components.textinput.TextInputStyle;
import net.dv8tion.jda.api.entities.Guild;
import net.dv8tion.jda.api.entities.Member;
import net.dv8tion.jda.api.entities.Message;
import net.dv8tion.jda.api.entities.MessageReference;
import net.dv8tion.jda.api.entities.Role;
import net.dv8tion.jda.api.events.interaction.ModalInteractionEvent;
import net.dv8tion.jda.api.events.interaction.component.ButtonInteractionEvent;
import net.dv8tion.jda.api.events.message.MessageReceivedEvent;
import net.dv8tion.jda.api.hooks.ListenerAdapter;
import net.dv8tion.jda.api.interactions.callbacks.IReplyCallback;
import net.dv8tion.jda.api.interactions.modals.ModalMapping;
import net.dv8tion.jda.api.modals.Modal;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Discord chat: administrators talk to Whispcord by @mentioning the bot.
 *
 * A message is forwarded to the orchestrator only when it mentions the bot directly (its user, or
 * its own managed role); @everyone and @here never count. The author must have Manage Server
 * (owners and Administrators do) or the message is ignored and its text never leaves Discord.
 * Only that one message is forwarded, never the surrounding conversation or a replied-to message.
 * Discord delivers the text of messages that mention the bot without the Message Content intent.
 *
 * Also handles Whispcord's Approve / Cancel buttons (and the "type DELETE" modal for plans that
 * delete things) by asking the orchestrator, which checks who clicked and their permissions live.
 *
 * Disabled unless WHISPCORD_EVENTS_WEBHOOK_URL is set; WHISPCORD_DISCORD_CHAT=false turns it off.
 */
@Component
public class DiscordChatListener extends ListenerAdapter {

    private static final Logger log = LoggerFactory.getLogger(DiscordChatListener.class);
    static final String PREFIX = "wc:";
    /** The orchestrator rejects longer prompts. */
    private static final int MAX_CONTENT = 4000;
    private static final Pattern RUN_ID = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static final String CONFIRM_INPUT = "confirmation";

    private final String webhookUrl;
    private final String secret;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    public DiscordChatListener(JDA jda,
                               @Value("${WHISPCORD_EVENTS_WEBHOOK_URL:}") String webhookUrl,
                               @Value("${WHISPCORD_MCP_SECRET:}") String secret,
                               @Value("${WHISPCORD_DISCORD_CHAT:true}") boolean enabled) {
        this.webhookUrl = webhookUrl;
        this.secret = secret;
        if (enabled && webhookUrl != null && !webhookUrl.isBlank()) {
            jda.addEventListener(this);
            log.info("Whispcord Discord chat: mentions from server managers will be posted to the orchestrator");
        }
    }

    // ---------- mentions ----------

    @Override
    public void onMessageReceived(MessageReceivedEvent event) {
        if (!event.isFromGuild()) return;
        if (event.isWebhookMessage() || event.getAuthor().isBot() || event.getAuthor().isSystem()) return;
        Member member = event.getMember();
        if (member == null) return;
        Guild guild = event.getGuild();
        Message message = event.getMessage();
        Role botRole = guild.getBotRole();
        if (!mentionsBot(message, guild.getSelfMember().getIdLong(), botRole)) return;
        // Owners and Administrators pass too: hasPermission accounts for both.
        if (!member.hasPermission(Permission.MANAGE_SERVER)) return;

        String prompt = stripBotMentions(message.getContentRaw(), guild.getSelfMember().getId(), botRole);
        if (prompt.length() > MAX_CONTENT) prompt = prompt.substring(0, MAX_CONTENT);
        MessageReference ref = message.getMessageReference();

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "mention");
        body.put("guildId", guild.getId());
        body.put("channelId", event.getChannel().getId());
        body.put("messageId", message.getId());
        body.put("authorId", event.getAuthor().getId());
        body.put("content", prompt);
        body.put("replyToMessageId", ref != null ? ref.getMessageId() : null);
        if (guild.getSelfMember().hasPermission(event.getGuildChannel(), Permission.MESSAGE_SEND)) {
            event.getChannel().sendTyping().queue(null, err -> { });
        }
        send(Json.write(body)).whenComplete((res, err) -> {
            if (err != null) log.warn("Failed to forward a mention for guild {}: {}", guild.getId(), err.getMessage());
            else if (res.statusCode() >= 300) log.warn("Orchestrator rejected a mention for guild {}: HTTP {}", guild.getId(), res.statusCode());
        });
    }

    /** True only for a direct mention of the bot user or the bot's own role, never @everyone/@here. */
    static boolean mentionsBot(Message message, long selfId, Role botRole) {
        if (message.getMentions().getUsers().stream().anyMatch(u -> u.getIdLong() == selfId)) return true;
        return botRole != null && message.getMentions().getRoles().contains(botRole);
    }

    static String stripBotMentions(String content, String selfId, Role botRole) {
        String out = content.replaceAll("<@!?" + selfId + ">", "");
        if (botRole != null) out = out.replace("<@&" + botRole.getId() + ">", "");
        return out.trim();
    }

    // ---------- buttons ----------

    @Override
    public void onButtonInteraction(ButtonInteractionEvent event) {
        String id = event.getComponentId();
        if (!id.startsWith(PREFIX)) return;
        String[] parts = id.split(":");
        if (parts.length != 3 || !RUN_ID.matcher(parts[2]).matches() || !event.isFromGuild()) {
            event.reply("That button no longer works.").setEphemeral(true).queue();
            return;
        }
        String action = parts[1];
        String runId = parts[2];
        if (action.equals("confirm")) {
            TextInput input = TextInput.create(CONFIRM_INPUT, TextInputStyle.SHORT)
                    .setPlaceholder("DELETE")
                    .setRequiredRange(1, 20)
                    .build();
            Modal modal = Modal.create(PREFIX + "confirm:" + runId, "Confirm deletions")
                    .addComponents(Label.of("Type DELETE to run this plan", input))
                    .build();
            event.replyModal(modal).queue();
            return;
        }
        if (!action.equals("approve") && !action.equals("cancel")) return;
        forward(event, event.getMessage(), action, runId, event.getGuild().getId(), event.getChannel().getId(), null);
    }

    @Override
    public void onModalInteraction(ModalInteractionEvent event) {
        String id = event.getModalId();
        if (!id.startsWith(PREFIX + "confirm:") || !event.isFromGuild()) return;
        String runId = id.substring((PREFIX + "confirm:").length());
        if (!RUN_ID.matcher(runId).matches()) return;
        ModalMapping value = event.getValue(CONFIRM_INPUT);
        String confirmation = value == null ? "" : value.getAsString().trim();
        forward(event, event.getMessage(), "approve", runId, event.getGuild().getId(), event.getChannel().getId(), confirmation);
    }

    /**
     * Asks the orchestrator to approve or cancel, and shows its answer only to the person who
     * clicked. When the orchestrator says the plan is finished with, the buttons are removed.
     */
    private void forward(IReplyCallback callback, Message source, String action, String runId,
                         String guildId, String channelId, String confirmation) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "interaction");
        body.put("action", action);
        body.put("runId", runId);
        body.put("guildId", guildId);
        body.put("channelId", channelId);
        body.put("messageId", source != null ? source.getId() : null);
        body.put("userId", callback.getUser().getId());
        if (confirmation != null) body.put("confirmation", confirmation);
        String json = Json.write(body);
        callback.deferReply(true).queue(hook -> send(json).whenComplete((res, err) -> {
            if (err != null || res.statusCode() >= 300) {
                log.warn("Orchestrator didn't handle a button for guild {}: {}", guildId,
                        err != null ? err.getMessage() : "HTTP " + res.statusCode());
                hook.sendMessage("Whispcord couldn't handle that right now. Try again in a moment.").queue();
                return;
            }
            String text = res.body() == null || res.body().isBlank() ? "Done." : res.body();
            hook.sendMessage(text.length() > 2000 ? text.substring(0, 1999) + "…" : text).queue();
            boolean done = res.headers().firstValue("x-whispcord-done").map("1"::equals).orElse(false);
            if (done && source != null) source.editMessageComponents(List.of()).queue(null, e -> { });
        }));
    }

    private java.util.concurrent.CompletableFuture<HttpResponse<String>> send(String json) {
        HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(webhookUrl))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json));
        if (secret != null && !secret.isBlank()) {
            req.header("Authorization", "Bearer " + secret);
        }
        return http.sendAsync(req.build(), HttpResponse.BodyHandlers.ofString());
    }
}
