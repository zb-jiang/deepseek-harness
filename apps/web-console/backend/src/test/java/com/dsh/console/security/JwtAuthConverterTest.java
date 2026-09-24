package com.dsh.console.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.dsh.console.user.UserJdbcRepository;
import com.dsh.console.user.dto.UserDto;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * JWT → AuthContext 转换与 JIT 建档测试:记录不存在时按 JWT claims
 * (email + user_metadata)插 pending_approval 行,替代原 Supabase 注册 trigger;
 * email claim 缺失不建档;status 非 active 保持无权限 principal 降级。
 */
class JwtAuthConverterTest {

    private static final String SUB = "auth-sub-1";
    private static final String EMAIL = "chen@example.com";

    private UserJdbcRepository userRepository;
    private JwtAuthConverter converter;

    @BeforeEach
    void setUp() {
        userRepository = mock(UserJdbcRepository.class);
        converter = new JwtAuthConverter(userRepository);
    }

    @Test
    void jitInsertPrefersUserMetadataOverEmailFallbacks() {
        when(userRepository.findByAuthSubject(SUB))
            .thenReturn(Optional.empty())
            .thenReturn(Optional.of(user("pending_approval")));
        Jwt jwt = jwt(Map.of("login_name", "chen-login", "display_name", "小陈"));

        JwtAuthConverter.AuthAuthenticationToken token =
            (JwtAuthConverter.AuthAuthenticationToken) converter.convert(jwt);

        verify(userRepository).insertPending(SUB, "chen-login", "小陈", EMAIL);
        assertThat(((AuthContext) token.getPrincipal()).platformUserId()).isNull();
        assertThat(((AuthContext) token.getPrincipal()).authSubject()).isEqualTo(SUB);
    }

    @Test
    void jitInsertFallsBackToEmailAndLocalPartWithoutMetadata() {
        when(userRepository.findByAuthSubject(SUB))
            .thenReturn(Optional.empty())
            .thenReturn(Optional.of(user("pending_approval")));
        Jwt jwt = jwt(null);

        converter.convert(jwt);

        verify(userRepository).insertPending(SUB, EMAIL, "chen", EMAIL);
    }

    @Test
    void missingEmailClaimSkipsJitInsertAndDegrades() {
        when(userRepository.findByAuthSubject(SUB)).thenReturn(Optional.empty());
        Jwt.Builder builder = Jwt.withTokenValue("token")
            .header("alg", "HS256")
            .claim("sub", SUB);

        JwtAuthConverter.AuthAuthenticationToken token =
            (JwtAuthConverter.AuthAuthenticationToken) converter.convert(builder.build());

        verify(userRepository, never()).insertPending(anyString(), anyString(), anyString(), anyString());
        AuthContext ctx = (AuthContext) token.getPrincipal();
        assertThat(ctx.platformUserId()).isNull();
        assertThat(ctx.roles()).isEmpty();
    }

    @Test
    void jitInsertRecheckEmptyStillDegrades() {
        when(userRepository.findByAuthSubject(SUB)).thenReturn(Optional.empty());

        JwtAuthConverter.AuthAuthenticationToken token =
            (JwtAuthConverter.AuthAuthenticationToken) converter.convert(jwt(null));

        verify(userRepository).insertPending(eq(SUB), anyString(), anyString(), eq(EMAIL));
        assertThat(((AuthContext) token.getPrincipal()).platformUserId()).isNull();
    }

    @Test
    void activeUserResolvesFullAuthContext() {
        UUID userId = UUID.randomUUID();
        when(userRepository.findByAuthSubject(SUB)).thenReturn(Optional.of(user(userId, "active")));
        Jwt jwt = jwt(null);

        JwtAuthConverter.AuthAuthenticationToken token =
            (JwtAuthConverter.AuthAuthenticationToken) converter.convert(jwt);

        verify(userRepository, never()).insertPending(anyString(), anyString(), anyString(), anyString());
        AuthContext ctx = (AuthContext) token.getPrincipal();
        assertThat(ctx.platformUserId()).isEqualTo(userId);
        assertThat(ctx.email()).isEqualTo(EMAIL);
        assertThat(ctx.roles()).containsExactly("normal_user");
        assertThat(token.getAuthorities())
            .extracting(Object::toString)
            .contains("ROLE_NORMAL_USER");
    }

    @Test
    void nonActiveUserKeepsNullPrincipal() {
        when(userRepository.findByAuthSubject(SUB)).thenReturn(Optional.of(user("disabled")));

        JwtAuthConverter.AuthAuthenticationToken token =
            (JwtAuthConverter.AuthAuthenticationToken) converter.convert(jwt(null));

        AuthContext ctx = (AuthContext) token.getPrincipal();
        assertThat(ctx.platformUserId()).isNull();
        assertThat(ctx.roles()).isEmpty();
    }

    private static Jwt jwt(Map<String, Object> metadata) {
        Jwt.Builder builder = Jwt.withTokenValue("token")
            .header("alg", "HS256")
            .claim("sub", SUB)
            .claim("email", EMAIL);
        if (metadata != null) {
            builder.claim("user_metadata", metadata);
        }
        return builder.build();
    }

    private static UserDto user(String status) {
        return user(null, status);
    }

    private static UserDto user(UUID id, String status) {
        return new UserDto(id, SUB, "chen-login", "小陈", EMAIL, status,
            List.of("normal_user"), null, null, null, null,
            null, null, null, null, null, null, List.of());
    }
}
