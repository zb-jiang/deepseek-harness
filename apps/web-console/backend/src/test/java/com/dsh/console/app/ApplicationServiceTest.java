package com.dsh.console.app;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.dsh.console.app.dto.ApplicationDto;
import com.dsh.console.audit.AuditService;
import com.dsh.console.membership.AppMembershipJdbcRepository;
import com.dsh.console.membership.dto.AppMembershipDto;
import com.dsh.console.security.AuthContext;
import com.dsh.console.skillhub.SkillHubRestClient;
import com.dsh.console.user.UserJdbcRepository;
import com.dsh.console.workflow.WorkflowDefinitionJdbcRepository;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.access.AccessDeniedException;

/**
 * 发起权限测试(design 2026-09-19 §5.1):system_admin/应用管理员/active 应用成员
 * 三类放行,其余拒绝(员工端发起流程的前提)。
 */
class ApplicationServiceTest {

    private ApplicationJdbcRepository appRepository;
    private AppMembershipJdbcRepository membershipRepository;
    private ApplicationService service;

    @BeforeEach
    void setUp() {
        appRepository = mock(ApplicationJdbcRepository.class);
        membershipRepository = mock(AppMembershipJdbcRepository.class);
        service = new ApplicationService(appRepository, mock(UserJdbcRepository.class),
            mock(WorkflowDefinitionJdbcRepository.class), mock(AuditService.class),
            mock(SkillHubRestClient.class), membershipRepository);
    }

    @Test
    void systemAdminCanStartAnyProcess() {
        assertThatCode(() -> service.checkCanStartProcess(auth("system_admin"), UUID.randomUUID()))
            .doesNotThrowAnyException();
    }

    @Test
    void appAdminCanStartProcess() {
        UUID userId = UUID.randomUUID();
        UUID appId = UUID.randomUUID();
        when(appRepository.findById(appId)).thenReturn(Optional.of(app(appId, List.of(userId))));

        assertThatCode(() -> service.checkCanStartProcess(auth("normal_user", userId), appId))
            .doesNotThrowAnyException();
    }

    @Test
    void activeAppMemberCanStartProcess() {
        UUID userId = UUID.randomUUID();
        UUID appId = UUID.randomUUID();
        when(appRepository.findById(appId)).thenReturn(Optional.of(app(appId, List.of())));
        when(membershipRepository.findByAppAndUser(appId, userId))
            .thenReturn(Optional.of(membership(appId, userId, "active")));

        assertThatCode(() -> service.checkCanStartProcess(auth("normal_user", userId), appId))
            .doesNotThrowAnyException();
    }

    @Test
    void nonMemberCannotStartProcess() {
        UUID userId = UUID.randomUUID();
        UUID appId = UUID.randomUUID();
        when(appRepository.findById(appId)).thenReturn(Optional.of(app(appId, List.of())));
        when(membershipRepository.findByAppAndUser(appId, userId))
            .thenReturn(Optional.of(membership(appId, userId, "revoked")));

        assertThatThrownBy(() -> service.checkCanStartProcess(auth("normal_user", userId), appId))
            .isInstanceOf(AccessDeniedException.class)
            .hasMessageContaining("不能发起该应用的流程");
    }

    @Test
    void startableAppIdsUnionAdminAndMembershipApps() {
        UUID userId = UUID.randomUUID();
        UUID adminApp = UUID.randomUUID();
        UUID bothApp = UUID.randomUUID();
        UUID memberApp = UUID.randomUUID();
        when(appRepository.listByAdminUser(userId))
            .thenReturn(List.of(app(adminApp, List.of(userId)), app(bothApp, List.of(userId))));
        when(membershipRepository.listActiveAppIdsByUser(userId))
            .thenReturn(List.of(bothApp, memberApp));

        assertThat(service.listStartableAppIds(auth("normal_user", userId)))
            .containsExactly(adminApp, bothApp, memberApp);
    }

    @Test
    void startableAppIdsEmptyWhenNeitherAdminNorMember() {
        UUID userId = UUID.randomUUID();
        when(appRepository.listByAdminUser(userId)).thenReturn(List.of());
        when(membershipRepository.listActiveAppIdsByUser(userId)).thenReturn(List.of());

        assertThat(service.listStartableAppIds(auth("normal_user", userId))).isEmpty();
    }

    private static AuthContext auth(String role) {
        return auth(role, UUID.randomUUID());
    }

    private static AuthContext auth(String role, UUID userId) {
        return new AuthContext(userId, "sub-1", "a@b.c", "login", "显示名", List.of(role));
    }

    private static ApplicationDto app(UUID appId, List<UUID> adminIds) {
        return new ApplicationDto(appId, "应用", null, null, null, "active",
            adminIds, OffsetDateTime.now(), null, null, null);
    }

    private static AppMembershipDto membership(UUID appId, UUID userId, String status) {
        return new AppMembershipDto(UUID.randomUUID(), appId, userId, List.of(),
            status, OffsetDateTime.now(), null);
    }
}
