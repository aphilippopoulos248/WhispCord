package dev.saseq.whispcord;

import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.Set;

/**
 * Guilds that have at least one active Whispcord live watch. The orchestrator replaces this set
 * through the set_live_watch_guilds tool (at boot, whenever watches change, and every minute).
 *
 * LiveMessageForwarder only forwards messages from these guilds, so servers without a watch never
 * have their messages sent anywhere.
 */
@Component
public class LiveWatchRegistry {

    private volatile Set<String> guildIds = Set.of();

    public boolean isWatched(String guildId) {
        return guildIds.contains(guildId);
    }

    public void replace(Collection<String> ids) {
        this.guildIds = Set.copyOf(ids);
    }

    public int size() {
        return guildIds.size();
    }
}
