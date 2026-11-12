package dev.saseq.whispcord;

import net.dv8tion.jda.api.JDA;
import net.dv8tion.jda.api.Permission;
import net.dv8tion.jda.api.entities.Guild;
import net.dv8tion.jda.api.entities.Member;
import net.dv8tion.jda.api.entities.Message;
import net.dv8tion.jda.api.entities.Role;
import net.dv8tion.jda.api.entities.ScheduledEvent;
import net.dv8tion.jda.api.entities.channel.middleman.GuildMessageChannel;
import net.dv8tion.jda.api.requests.GatewayIntent;
import net.dv8tion.jda.api.entities.emoji.RichCustomEmoji;
import net.dv8tion.jda.api.entities.channel.attribute.ICategorizableChannel;
import net.dv8tion.jda.api.entities.channel.attribute.IPositionableChannel;
import net.dv8tion.jda.api.entities.channel.middleman.GuildChannel;
import net.dv8tion.jda.api.exceptions.ErrorResponseException;
import net.dv8tion.jda.api.requests.ErrorResponse;
import org.springframework.ai.tool.annotation.Tool;
import org.springframework.ai.tool.annotation.ToolParam;
import org.springframework.stereotype.Service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.concurrent.TimeUnit;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Whispcord-specific tools. Kept separate from the upstream services so merges from
 * SaseQ/discord-mcp stay conflict-free.
 *
 * Every tool here returns JSON (not prose) because the Whispcord orchestrator parses it to make
 * security decisions. These tools are never exposed to Claude directly.
 */
@Service
public class WhispcordService {

    /** Permissions the bot needs for the Builder tier. Mirrors packages/shared permissions.ts. */
    static final EnumSet<Permission> BUILDER_PERMISSIONS = EnumSet.of(
            Permission.VIEW_CHANNEL,
            Permission.MESSAGE_SEND,
            Permission.MESSAGE_HISTORY,
            Permission.MANAGE_CHANNEL,
            Permission.MANAGE_ROLES,
            Permission.MANAGE_WEBHOOKS,
            Permission.MANAGE_GUILD_EXPRESSIONS,
            Permission.MANAGE_EVENTS,
            Permission.MANAGE_THREADS,
            Permission.CREATE_INSTANT_INVITE
    );

    private final JDA jda;

    public WhispcordService(JDA jda) {
        this.jda = jda;
    }

    private Guild requireGuild(String guildId) {
        if (guildId == null || guildId.isBlank()) {
            throw new IllegalArgumentException("guildId is required");
        }
        Guild guild = jda.getGuildById(guildId);
        if (guild == null) {
            throw new IllegalArgumentException("Bot is not in guild " + guildId);
        }
        return guild;
    }

    private static int highestRolePosition(Member member) {
        // getRoles() is sorted highest first; @everyone (position 0) is not included.
        List<Role> roles = member.getRoles();
        return roles.isEmpty() ? 0 : roles.get(0).getPosition();
    }

    /**
     * Live permission check for a human user. The orchestrator calls this at connect time and at
     * the start of every run, so a user who loses Manage Server loses Whispcord access immediately.
     */
    @Tool(name = "check_member_permissions",
            description = "Whispcord internal: returns a member's effective guild permissions as JSON")
    public String checkMemberPermissions(
            @ToolParam(description = "Discord server ID") String guildId,
            @ToolParam(description = "Discord user ID") String userId) {
        if (userId == null || userId.isBlank()) {
            throw new IllegalArgumentException("userId is required");
        }
        Guild guild = jda.getGuildById(guildId == null ? "" : guildId);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("guildId", guildId);
        out.put("userId", userId);
        if (guild == null) {
            out.put("botInGuild", false);
            out.put("isMember", false);
            out.put("canManageServer", false);
            return Json.write(out);
        }
        out.put("botInGuild", true);

        Member member;
        try {
            member = guild.retrieveMemberById(userId).complete();
        } catch (ErrorResponseException e) {
            if (e.getErrorResponse() == ErrorResponse.UNKNOWN_MEMBER
                    || e.getErrorResponse() == ErrorResponse.UNKNOWN_USER) {
                out.put("isMember", false);
                out.put("canManageServer", false);
                return Json.write(out);
            }
            throw e;
        }

        EnumSet<Permission> perms = member.getPermissions();
        boolean isOwner = member.isOwner();
        boolean isAdmin = perms.contains(Permission.ADMINISTRATOR);
        out.put("isMember", true);
        out.put("isOwner", isOwner);
        out.put("isAdministrator", isAdmin);
        out.put("canManageServer", isOwner || isAdmin || perms.contains(Permission.MANAGE_SERVER));
        out.put("canManageRoles", isOwner || isAdmin || perms.contains(Permission.MANAGE_ROLES));
        out.put("canManageChannels", isOwner || isAdmin || perms.contains(Permission.MANAGE_CHANNEL));
        out.put("permissions", Long.toString(Permission.getRaw(perms)));
        out.put("highestRolePosition", isOwner ? Integer.MAX_VALUE : highestRolePosition(member));
        return Json.write(out);
    }

    /**
     * Bot presence/health in one guild: needed for the connect flow and for explaining
     * "can't edit roles above mine" errors.
     */
    @Tool(name = "get_bot_status",
            description = "Whispcord internal: returns whether the bot is in a guild, its top role position and permissions as JSON")
    public String getBotStatus(@ToolParam(description = "Discord server ID") String guildId) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("guildId", guildId);
        Guild guild = guildId == null ? null : jda.getGuildById(guildId);
        if (guild == null) {
            out.put("inGuild", false);
            return Json.write(out);
        }
        Member self = guild.getSelfMember();
        EnumSet<Permission> perms = self.getPermissions();
        List<String> missing = new ArrayList<>();
        if (!perms.contains(Permission.ADMINISTRATOR)) {
            for (Permission p : BUILDER_PERMISSIONS) {
                if (!perms.contains(p)) missing.add(p.name());
            }
        }
        int top = highestRolePosition(self);
        int maxOtherRolePosition = 0;
        int rolesAboveBot = 0;
        for (Role r : guild.getRoles()) {
            if (r.isPublicRole() || self.getRoles().contains(r)) continue;
            maxOtherRolePosition = Math.max(maxOtherRolePosition, r.getPosition());
            if (r.getPosition() > top) rolesAboveBot++;
        }
        out.put("inGuild", true);
        out.put("guildName", guild.getName());
        out.put("guildIcon", guild.getIconUrl());
        out.put("ownerId", guild.getOwnerId());
        out.put("memberCount", guild.getMemberCount());
        out.put("botUserId", self.getId());
        out.put("highestRolePosition", top);
        out.put("maxOtherRolePosition", maxOtherRolePosition);
        out.put("rolesAboveBot", rolesAboveBot);
        out.put("permissions", Long.toString(Permission.getRaw(perms)));
        out.put("missingPermissions", missing);
        out.put("isAdministrator", perms.contains(Permission.ADMINISTRATOR));
        return Json.write(out);
    }

    static final int SCAN_MAX_PER_CHANNEL = 500;
    static final int SCAN_MAX_TOTAL = 2000;
    static final int SCAN_MAX_HOURS = 24 * 90;

    private static int clamp(String raw, int dflt, int min, int max) {
        if (raw == null || raw.isBlank()) return dflt;
        try {
            return Math.max(min, Math.min(max, Integer.parseInt(raw.trim())));
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("Expected a number, got: " + raw);
        }
    }

    /**
     * Recent messages from a guild's text channels, as JSON, for Whispcord's message search.
     * Bounded (per channel, total and by age) so one request can't pull a server's whole history.
     * The orchestrator only exposes this when the server owner enabled "Message search", and it
     * sends the text to a tool-less classifier, never to the planner.
     *
     * Message text is only returned by Discord when the app has the Message Content intent;
     * without it `content` is empty and `contentAvailable` is false.
     */
    @Tool(name = "scan_messages",
            description = "Whispcord internal: returns recent messages from text channels as JSON")
    public String scanMessages(
            @ToolParam(description = "Discord server ID") String guildId,
            @ToolParam(description = "Comma-separated channel IDs; empty means every text channel the bot can read", required = false) String channelIds,
            @ToolParam(description = "Max messages per channel (1-500, default 100)", required = false) String limitPerChannel,
            @ToolParam(description = "Only messages from the last N hours (1-2160, default 168)", required = false) String sinceHours,
            @ToolParam(description = "Max messages in total (1-2000, default 1000)", required = false) String maxTotal) {
        Guild guild = requireGuild(guildId);
        Member self = guild.getSelfMember();
        int perChannel = clamp(limitPerChannel, 100, 1, SCAN_MAX_PER_CHANNEL);
        int total = clamp(maxTotal, 1000, 1, SCAN_MAX_TOTAL);
        int hours = clamp(sinceHours, 168, 1, SCAN_MAX_HOURS);
        OffsetDateTime cutoff = OffsetDateTime.now().minusHours(hours);

        List<GuildMessageChannel> channels = new ArrayList<>();
        List<Map<String, Object>> skipped = new ArrayList<>();
        if (channelIds != null && !channelIds.isBlank()) {
            for (String raw : channelIds.split(",")) {
                String id = raw.trim();
                if (id.isEmpty()) continue;
                GuildChannel ch = guild.getGuildChannelById(id);
                if (ch instanceof GuildMessageChannel gmc) {
                    channels.add(gmc);
                } else {
                    skipped.add(Map.of("id", id, "reason", ch == null ? "not found in this server" : "not a text channel"));
                }
            }
        } else {
            channels.addAll(guild.getTextChannels());
            channels.addAll(guild.getNewsChannels());
        }

        List<Map<String, Object>> messages = new ArrayList<>();
        List<String> scanned = new ArrayList<>();
        boolean truncated = false;
        int withContent = 0;
        int othersChecked = 0;
        for (GuildMessageChannel channel : channels) {
            if (!self.hasPermission(channel, Permission.VIEW_CHANNEL, Permission.MESSAGE_HISTORY)) {
                skipped.add(Map.of("id", channel.getId(), "name", channel.getName(), "reason", "bot can't read this channel"));
                continue;
            }
            int remaining = total - messages.size();
            if (remaining <= 0) {
                truncated = true;
                break;
            }
            List<Message> batch;
            try {
                batch = channel.getIterableHistory().cache(false)
                        .takeUntilAsync(Math.min(perChannel, remaining), m -> m.getTimeCreated().isBefore(cutoff))
                        .get(60, TimeUnit.SECONDS);
            } catch (Exception e) {
                skipped.add(Map.of("id", channel.getId(), "name", channel.getName(), "reason", "could not read: " + e.getClass().getSimpleName()));
                continue;
            }
            scanned.add(channel.getId());
            for (Message m : batch) {
                // Skip the bot's own messages: never what an admin is searching for.
                if (m.getAuthor().getIdLong() == self.getIdLong()) continue;
                String content = m.getContentRaw();
                // Discord shows a bot messages that mention it even without the Message Content
                // intent, so those can't tell us whether text is visible in general.
                boolean mentionsBot = m.getMentions().isMentioned(self);
                if (!mentionsBot) {
                    othersChecked++;
                    if (!content.isEmpty()) withContent++;
                }
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("id", m.getId());
                out.put("channelId", channel.getId());
                out.put("channelName", channel.getName());
                out.put("authorId", m.getAuthor().getId());
                out.put("authorName", m.getMember() != null ? m.getMember().getEffectiveName() : m.getAuthor().getName());
                out.put("authorIsBot", m.getAuthor().isBot());
                out.put("createdAt", m.getTimeCreated().toString());
                out.put("content", content);
                out.put("attachments", m.getAttachments().size());
                out.put("jumpUrl", m.getJumpUrl());
                messages.add(out);
            }
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("guildId", guild.getId());
        out.put("sinceHours", hours);
        out.put("scannedChannels", scanned);
        out.put("skippedChannels", skipped);
        out.put("truncated", truncated);
        out.put("messageContentIntent", jda.getGatewayIntents().contains(GatewayIntent.MESSAGE_CONTENT));
        // Without the intent Discord sends other people's messages with empty content.
        out.put("contentAvailable", othersChecked == 0 || withContent > 0);
        out.put("messages", messages);
        return Json.write(out);
    }

    /**
     * Compact, machine-readable structure of a guild. The orchestrator uses it to (a) give Claude
     * a summary of the current layout and (b) validate that every ID in a plan belongs to the
     * run's guild.
     */
    @Tool(name = "get_guild_snapshot",
            description = "Whispcord internal: returns the guild's categories, channels and roles as JSON")
    public String getGuildSnapshot(@ToolParam(description = "Discord server ID") String guildId) {
        Guild guild = requireGuild(guildId);
        Member self = guild.getSelfMember();

        List<Map<String, Object>> channels = new ArrayList<>();
        for (GuildChannel ch : guild.getChannels()) {
            Map<String, Object> c = new LinkedHashMap<>();
            c.put("id", ch.getId());
            c.put("name", ch.getName());
            c.put("type", ch.getType().name());
            String parentId = null;
            if (ch instanceof ICategorizableChannel cat && cat.getParentCategoryIdLong() != 0) {
                parentId = cat.getParentCategoryId();
            }
            c.put("parentId", parentId);
            c.put("position", ch instanceof IPositionableChannel pos ? pos.getPosition() : 0);
            channels.add(c);
        }

        List<Map<String, Object>> roles = new ArrayList<>();
        for (Role r : guild.getRoles()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.getId());
            m.put("name", r.getName());
            m.put("position", r.getPosition());
            m.put("color", r.getColorRaw());
            m.put("permissions", Long.toString(r.getPermissionsRaw()));
            m.put("managed", r.isManaged());
            m.put("isEveryone", r.isPublicRole());
            m.put("hoisted", r.isHoisted());
            roles.add(m);
        }

        List<Map<String, Object>> emojis = new ArrayList<>();
        for (RichCustomEmoji e : guild.getEmojis()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", e.getId());
            m.put("name", e.getName());
            emojis.add(m);
        }

        List<Map<String, Object>> events = new ArrayList<>();
        for (ScheduledEvent ev : guild.getScheduledEvents()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", ev.getId());
            m.put("name", ev.getName());
            events.add(m);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("guildId", guild.getId());
        out.put("name", guild.getName());
        out.put("icon", guild.getIconUrl());
        out.put("ownerId", guild.getOwnerId());
        out.put("memberCount", guild.getMemberCount());
        out.put("botHighestRolePosition", highestRolePosition(self));
        out.put("channels", channels);
        out.put("roles", roles);
        out.put("emojis", emojis);
        out.put("events", events);
        return Json.write(out);
    }
}
