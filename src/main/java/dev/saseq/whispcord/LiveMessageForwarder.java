package dev.saseq.whispcord;

import net.dv8tion.jda.api.JDA;
import net.dv8tion.jda.api.entities.Message;
import net.dv8tion.jda.api.entities.channel.concrete.ThreadChannel;
import net.dv8tion.jda.api.entities.channel.middleman.GuildMessageChannel;
import net.dv8tion.jda.api.events.message.MessageReceivedEvent;
import net.dv8tion.jda.api.hooks.ListenerAdapter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Forwards new messages to the Whispcord orchestrator for live moderation, but only from guilds
 * in {@link LiveWatchRegistry} (servers whose owner approved a live watch). Bot, webhook and
 * system messages are skipped. Disabled unless WHISPCORD_EVENTS_WEBHOOK_URL is set.
 *
 * Image attachments are forwarded as Discord CDN links (not downloaded here); the orchestrator
 * fetches them from Discord's CDN only. Message text and links are never logged here. The
 * orchestrator sends them only to a tool-less classifier.
 */
@Component
public class LiveMessageForwarder extends ListenerAdapter {

    private static final Logger log = LoggerFactory.getLogger(LiveMessageForwarder.class);
    /** Discord allows 4000 characters (Nitro); the classifier only reads the first 1500. */
    private static final int MAX_CONTENT = 2000;
    /** Images per message passed on (the classifier's limits are enforced again by the orchestrator). */
    private static final int MAX_IMAGES = 4;
    /** Anthropic accepts images up to 5 MB. */
    private static final long MAX_IMAGE_BYTES = 5L * 1024 * 1024;
    private static final Set<String> IMAGE_TYPES = Set.of("image/jpeg", "image/png", "image/gif", "image/webp");

    private final LiveWatchRegistry registry;
    private final String webhookUrl;
    private final String secret;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    public LiveMessageForwarder(JDA jda,
                                LiveWatchRegistry registry,
                                @Value("${WHISPCORD_EVENTS_WEBHOOK_URL:}") String webhookUrl,
                                @Value("${WHISPCORD_MCP_SECRET:}") String secret) {
        this.registry = registry;
        this.webhookUrl = webhookUrl;
        this.secret = secret;
        if (webhookUrl != null && !webhookUrl.isBlank()) {
            jda.addEventListener(this);
            log.info("Whispcord live watch: new messages from watched servers will be posted to the orchestrator");
        }
    }

    @Override
    public void onMessageReceived(MessageReceivedEvent event) {
        if (!event.isFromGuild() || registry.size() == 0) return;
        String guildId = event.getGuild().getId();
        if (!registry.isWatched(guildId)) return;
        if (event.isWebhookMessage() || event.getAuthor().isBot() || event.getAuthor().isSystem()) return;
        Message message = event.getMessage();
        String content = message.getContentRaw();
        List<Map<String, Object>> images = images(message);
        if (content.isBlank() && images.isEmpty()) return; // stickers, files or embeds only: nothing to classify

        GuildMessageChannel channel = event.getGuildChannel();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "message_create");
        body.put("guildId", guildId);
        body.put("channelId", channel.getId());
        body.put("parentChannelId", channel instanceof ThreadChannel thread ? thread.getParentChannel().getId() : null);
        body.put("channelName", channel.getName());
        body.put("messageId", message.getId());
        body.put("authorId", event.getAuthor().getId());
        body.put("authorName", event.getMember() != null ? event.getMember().getEffectiveName() : event.getAuthor().getName());
        body.put("createdAt", message.getTimeCreated().toString());
        body.put("content", content.length() > MAX_CONTENT ? content.substring(0, MAX_CONTENT) : content);
        body.put("jumpUrl", message.getJumpUrl());
        body.put("images", images);
        post(guildId, Json.write(body));
    }

    /** Image attachments the classifier can read: JPEG, PNG, GIF or WebP, up to 5 MB, at most 4. */
    private static List<Map<String, Object>> images(Message message) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Message.Attachment a : message.getAttachments()) {
            if (out.size() >= MAX_IMAGES) break;
            String type = a.getContentType() == null ? "" : a.getContentType().split(";")[0].trim().toLowerCase();
            if (!a.isImage() || !IMAGE_TYPES.contains(type) || a.getSize() > MAX_IMAGE_BYTES) continue;
            Map<String, Object> img = new LinkedHashMap<>();
            img.put("url", a.getUrl());
            img.put("contentType", type);
            img.put("size", a.getSize());
            out.add(img);
        }
        return out;
    }

    private void post(String guildId, String json) {
        HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(webhookUrl))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json));
        if (secret != null && !secret.isBlank()) {
            req.header("Authorization", "Bearer " + secret);
        }
        http.sendAsync(req.build(), HttpResponse.BodyHandlers.discarding())
                .whenComplete((res, err) -> {
                    if (err != null) {
                        log.warn("Failed to forward a message for guild {}: {}", guildId, err.getMessage());
                    } else if (res.statusCode() >= 300) {
                        log.warn("Orchestrator rejected a forwarded message for guild {}: HTTP {}", guildId, res.statusCode());
                    }
                });
    }
}
