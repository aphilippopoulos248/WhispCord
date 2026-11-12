package dev.saseq.whispcord;

import net.dv8tion.jda.api.JDA;
import net.dv8tion.jda.api.events.guild.GuildJoinEvent;
import net.dv8tion.jda.api.events.guild.GuildLeaveEvent;
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
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Posts guild join/leave events to the Whispcord orchestrator so a server is marked
 * Disconnected as soon as someone kicks the bot. Disabled unless WHISPCORD_EVENTS_WEBHOOK_URL is set.
 */
@Component
public class GuildMembershipNotifier extends ListenerAdapter {

    private static final Logger log = LoggerFactory.getLogger(GuildMembershipNotifier.class);

    private final String webhookUrl;
    private final String secret;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    public GuildMembershipNotifier(JDA jda,
                                   @Value("${WHISPCORD_EVENTS_WEBHOOK_URL:}") String webhookUrl,
                                   @Value("${WHISPCORD_MCP_SECRET:}") String secret) {
        this.webhookUrl = webhookUrl;
        this.secret = secret;
        if (webhookUrl != null && !webhookUrl.isBlank()) {
            jda.addEventListener(this);
            log.info("Whispcord guild membership events will be posted to the orchestrator");
        }
    }

    @Override
    public void onGuildJoin(GuildJoinEvent event) {
        post("guild_join", event.getGuild().getId(), event.getGuild().getName());
    }

    @Override
    public void onGuildLeave(GuildLeaveEvent event) {
        post("guild_leave", event.getGuild().getId(), event.getGuild().getName());
    }

    private void post(String type, String guildId, String guildName) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", type);
        body.put("guildId", guildId);
        body.put("guildName", guildName);
        HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(webhookUrl))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(Json.write(body)));
        if (secret != null && !secret.isBlank()) {
            req.header("Authorization", "Bearer " + secret);
        }
        http.sendAsync(req.build(), HttpResponse.BodyHandlers.discarding())
                .whenComplete((res, err) -> {
                    if (err != null) {
                        log.warn("Failed to post {} for guild {}: {}", type, guildId, err.getMessage());
                    } else if (res.statusCode() >= 300) {
                        log.warn("Orchestrator rejected {} for guild {}: HTTP {}", type, guildId, res.statusCode());
                    }
                });
    }
}
