package dev.saseq.whispcord;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Defence in depth for the MCP endpoint. The MCP server must only ever be reachable on a private
 * network, but if WHISPCORD_MCP_SECRET is set every request to /mcp must also carry
 * "Authorization: Bearer <secret>". Health checks stay open.
 */
@Component
public class McpSharedSecretFilter extends OncePerRequestFilter {

    private final byte[] secret;

    public McpSharedSecretFilter(@Value("${WHISPCORD_MCP_SECRET:}") String secret) {
        this.secret = secret == null ? new byte[0] : secret.getBytes(StandardCharsets.UTF_8);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return secret.length == 0 || !request.getRequestURI().startsWith("/mcp");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String header = request.getHeader("Authorization");
        String prefix = "Bearer ";
        byte[] provided = header != null && header.startsWith(prefix)
                ? header.substring(prefix.length()).getBytes(StandardCharsets.UTF_8)
                : new byte[0];
        if (!MessageDigest.isEqual(secret, provided)) {
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType("application/json");
            response.getWriter().write("{\"error\":\"unauthorized\"}");
            return;
        }
        chain.doFilter(request, response);
    }
}
