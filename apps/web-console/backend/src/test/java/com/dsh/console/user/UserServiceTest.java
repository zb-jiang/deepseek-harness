package com.dsh.console.user;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.dsh.console.app.ApplicationJdbcRepository;
import com.dsh.console.audit.AuditService;
import com.dsh.console.common.GlobalExceptionHandler.NotFoundException;
import com.dsh.console.orgunit.OrgUnitJdbcRepository;
import com.dsh.console.orgunit.OrgUnitMemberJdbcRepository;
import com.dsh.console.orgunit.dto.OrgUnitDto;
import com.dsh.console.runtime.FlowableRestClient;
import com.dsh.console.user.dto.UserDto;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * 用户所属部门多对多覆盖写测试(design 2026-09-19 决策 10/12):
 * 部门存在性校验;被移出部门中用户是负责人则阻止(先更换负责人);
 * 通过守卫后按全量覆盖写 org_unit_members。
 */
class UserServiceTest {

    private UserJdbcRepository userRepository;
    private OrgUnitJdbcRepository orgUnitRepository;
    private OrgUnitMemberJdbcRepository memberRepository;
    private UserService service;

    @BeforeEach
    void setUp() {
        userRepository = mock(UserJdbcRepository.class);
        orgUnitRepository = mock(OrgUnitJdbcRepository.class);
        memberRepository = mock(OrgUnitMemberJdbcRepository.class);
        service = new UserService(userRepository, mock(ApplicationJdbcRepository.class),
            mock(FlowableRestClient.class), mock(AuditService.class),
            orgUnitRepository, memberRepository);
    }

    @Test
    void assignOrgUnitsRejectsUnknownDepartment() {
        UUID userId = UUID.randomUUID();
        when(userRepository.findById(userId)).thenReturn(Optional.of(user(userId)));
        UUID unknownDept = UUID.randomUUID();
        when(orgUnitRepository.findById(unknownDept)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.assignOrgUnits(
            userId, List.of(unknownDept), UUID.randomUUID()))
            .isInstanceOf(NotFoundException.class)
            .hasMessageContaining("部门不存在");
        verify(memberRepository, never()).replaceForUser(any(), anyList());
    }

    @Test
    void assignOrgUnitsBlocksRemovingHeadOfDepartment() {
        UUID userId = UUID.randomUUID();
        UUID deptId = UUID.randomUUID();
        when(userRepository.findById(userId)).thenReturn(Optional.of(user(userId)));
        when(memberRepository.findOrgUnitIdsByUser(userId)).thenReturn(List.of(deptId));
        // 用户是 deptId 的负责人,覆盖写要移出该部门 → 阻止
        when(orgUnitRepository.findById(deptId)).thenReturn(
            Optional.of(unit(deptId, "A 部门", userId)));

        assertThatThrownBy(() -> service.assignOrgUnits(userId, List.of(), UUID.randomUUID()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("先更换负责人再移出该部门");
        verify(memberRepository, never()).replaceForUser(any(), anyList());
    }

    @Test
    void assignOrgUnitsReplacesMembershipWhenGuardsPass() {
        UUID userId = UUID.randomUUID();
        UUID deptA = UUID.randomUUID();
        UUID deptB = UUID.randomUUID();
        when(userRepository.findById(userId)).thenReturn(Optional.of(user(userId)));
        // 现隶属 A(自己是负责人),新清单保留 A 并加入 B → 守卫通过,覆盖写
        when(memberRepository.findOrgUnitIdsByUser(userId)).thenReturn(List.of(deptA));
        when(orgUnitRepository.findById(deptA)).thenReturn(
            Optional.of(unit(deptA, "A 部门", userId)));
        when(orgUnitRepository.findById(deptB)).thenReturn(
            Optional.of(unit(deptB, "B 部门", null)));

        service.assignOrgUnits(userId, List.of(deptA, deptB), UUID.randomUUID());

        verify(memberRepository).replaceForUser(userId, List.of(deptA, deptB));
    }

    private static UserDto user(UUID id) {
        return new UserDto(id, "sub-" + id, "login", "显示名", "a@b.c", "active",
            List.of(), OffsetDateTime.now(), null, null, null, null, null, null,
            null, null, null, List.of());
    }

    private static OrgUnitDto unit(UUID id, String name, UUID headUserId) {
        return new OrgUnitDto(id, name, null, headUserId, 0, OffsetDateTime.now());
    }
}
