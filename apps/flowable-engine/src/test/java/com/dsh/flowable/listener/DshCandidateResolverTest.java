package com.dsh.flowable.listener;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.dsh.flowable.listener.DshCandidateResolver.Resolution;
import com.dsh.flowable.listener.DshExtensionProperties.AssignmentRule;
import com.dsh.flowable.repository.DshMembershipRepository;
import com.dsh.flowable.repository.DshOrgUnitRepository;
import com.dsh.flowable.repository.DshOrgUnitRepository.OrgUnit;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * 组织维度候选解析器单测(design 2026-09-19 §2.2 矩阵 + §5.3/§5.4 全部边界)。
 *
 * <p>组织树 fixture(设计文档 §2.3):总公司(马总) → 华东区(老周) → A部门(张三)/B部门(李四);
 * 财务部(钱姐)直属总公司。小王是 A 部门员工。
 *
 * <p>链式模型:从锚点部门(含)逐级向上,「可用负责人」= head 非空且 ≠ 锚点人;
 * parent=链上第 1 个,grandparent=第 2 个;链耗尽=结构到顶自动通过。
 */
class DshCandidateResolverTest {

    // ---- 组织树 fixture(§2.3) ----
    private static final String ROOT = "unit-root";
    private static final String HUADONG = "unit-huadong";
    private static final String DEPT_A = "unit-a";
    private static final String DEPT_B = "unit-b";
    private static final String FINANCE = "unit-finance";

    private static final String MAZONG = "user-mazong";     // 总公司负责人
    private static final String LAOZHOU = "user-laozhou";   // 华东区负责人
    private static final String ZHANGSAN = "user-zhangsan"; // A 部门负责人
    private static final String LISI = "user-lisi";        // B 部门负责人
    private static final String QIANJIE = "user-qianjie";  // 财务部负责人
    private static final String XIAOWANG = "user-xiaowang";// A 部门员工(申请人)

    private static final String ROLE_MANAGER = "role-manager";
    private static final String ROLE_CFO = "role-cfo";

    /** 部门→该部门内持有某角色的成员(实体角色成员分布)。 */
    private final Map<String, List<String>> roleMembersByUnit = new HashMap<>(Map.of(
        DEPT_A, List.of(ZHANGSAN),
        FINANCE, List.of(QIANJIE),
        HUADONG, List.of(LAOZHOU)
    ));

    private final DshOrgUnitRepository orgRepo = new DshOrgUnitRepository(null) {
        @Override
        public List<OrgUnit> loadAll() {
            return List.of(
                new OrgUnit(ROOT, "总公司", null, MAZONG),
                new OrgUnit(HUADONG, "华东区", ROOT, LAOZHOU),
                new OrgUnit(DEPT_A, "A部门", HUADONG, ZHANGSAN),
                new OrgUnit(DEPT_B, "B部门", HUADONG, LISI),
                new OrgUnit(FINANCE, "财务部", ROOT, QIANJIE)
            );
        }

        @Override
        public Map<String, List<String>> findRoleMembersByOrgUnitIds(String roleId, java.util.Collection<String> orgUnitIds) {
            Map<String, List<String>> result = new HashMap<>();
            for (String unitId : orgUnitIds) {
                if ((ROLE_CFO.equals(roleId) && FINANCE.equals(unitId))) {
                    result.put(unitId, List.of(QIANJIE));
                } else if (ROLE_MANAGER.equals(roleId) && roleMembersByUnit.containsKey(unitId)) {
                    result.put(unitId, roleMembersByUnit.get(unitId));
                }
            }
            return result;
        }
    };

    private final DshMembershipRepository memRepo = new DshMembershipRepository(null) {
        @Override
        public List<String> findActiveUserIdsByRoleId(String roleId) {
            return ROLE_CFO.equals(roleId) ? List.of(QIANJIE, MAZONG) : List.of(ZHANGSAN, LAOZHOU);
        }
    };

    private final DshCandidateResolver resolver = new DshCandidateResolver(orgRepo, memRepo);

    // ---- §2.2 组合矩阵六场景 ----

    @Test
    void parentResolvesFromOwnDepartmentIncludingItself() {
        // 场景1:sameLine + 虚拟 parent。小王(A 员工)→ A 负责人张三(含本部门)
        Resolution r = resolver.resolveForApplicant(new AssignmentRule(null, null, "parent", null), DEPT_A, XIAOWANG);
        assertThat(r.structuralTopAutoPass()).isFalse();
        assertThat(r.candidates()).containsExactly(ZHANGSAN);
    }

    @Test
    void sameLineRoleFindsFirstMatchUpward() {
        // 场景2:sameLine + 实体角色。小王所在 A 无经理成员→上翻华东区找到老周
        roleMembersByUnit.remove(DEPT_A);
        Resolution r = resolver.resolveForApplicant(new AssignmentRule(ROLE_MANAGER, "sameLine", null, null), DEPT_A, XIAOWANG);
        assertThat(r.candidates()).containsExactly(LAOZHOU);
    }

    @Test
    void sameLineRoleSkipsApplicantThenGoesUpward() {
        // §5.4:A 部门只有申请人自己是经理→跳过本人上翻华东区
        roleMembersByUnit.put(DEPT_A, List.of(XIAOWANG));
        Resolution r = resolver.resolveForApplicant(new AssignmentRule(ROLE_MANAGER, "sameLine", null, null), DEPT_A, XIAOWANG);
        assertThat(r.candidates()).containsExactly(LAOZHOU);
    }

    @Test
    void grandparentResolvesSecondAvailableUpward() {
        // 场景3:sameLine + 虚拟 grandparent。小王链=[A张三,华东老周,总公司马总]→第2个=老周
        Resolution r = resolver.resolveForApplicant(new AssignmentRule(null, null, "grandparent", null), DEPT_A, XIAOWANG);
        assertThat(r.candidates()).containsExactly(LAOZHOU);
    }

    @Test
    void childFansOutDirectChildrenHeads() {
        // 场景4:sameLine + 虚拟 child。马总(总公司)→直接子部门[华东,财务]负责人[老周,钱姐]
        Resolution r = resolver.resolveForApplicant(new AssignmentRule(null, null, "child", null), ROOT, MAZONG);
        assertThat(r.candidates()).containsExactlyInAnyOrder(LAOZHOU, QIANJIE);
    }

    @Test
    void grandchildFansOutGrandchildrenHeads() {
        // 场景4(下两级):马总→孙子部门[A,B]负责人[张三,李四]
        Resolution r = resolver.resolveForApplicant(new AssignmentRule(null, null, "grandchild", null), ROOT, MAZONG);
        assertThat(r.candidates()).containsExactlyInAnyOrder(ZHANGSAN, LISI);
    }

    @Test
    void fixedUnitResolvesRoleMembersInSubtree() {
        // 场景5:fixedUnit + 实体 CFO。财务部子树内的 CFO 成员=钱姐
        Resolution r = resolver.resolveForApplicant(
            new AssignmentRule(ROLE_CFO, "fixedUnit", null, FINANCE), DEPT_A, XIAOWANG);
        assertThat(r.candidates()).containsExactly(QIANJIE);
    }

    @Test
    void globalResolvesAllRoleMembers() {
        // 场景6:global + 实体角色=全公司成员(与存量一致)
        Resolution r = resolver.resolveForApplicant(
            new AssignmentRule(ROLE_CFO, "global", null, null), null, XIAOWANG);
        assertThat(r.candidates()).containsExactlyInAnyOrder(QIANJIE, MAZONG);
    }

    // ---- §5.3/§5.4 边界规则 ----

    @Test
    void parentAtStructuralTopAutoPasses() {
        // 边界:马总(总公司负责人)提交 parent→链耗尽→结构到顶自动通过
        Resolution r = resolver.resolveForApplicant(new AssignmentRule(null, null, "parent", null), ROOT, MAZONG);
        assertThat(r.structuralTopAutoPass()).isTrue();
        assertThat(r.candidates()).isEmpty();
    }

    @Test
    void managerEscalatesAboveOwnDepartment() {
    // §2.1 双锚点/层级自适应:张三(A 负责人)提交 parent→跳过 A→华东负责人老周
        Resolution r = resolver.resolveForApplicant(new AssignmentRule(null, null, "parent", null), DEPT_A, ZHANGSAN);
        assertThat(r.candidates()).containsExactly(LAOZHOU);
    }

    @Test
    void missingHeadOnChainThrowsDataError() {
        // 边界:申请人有部门,链上级部门未配负责人→数据缺失报错(不静默)
        DshOrgUnitRepository brokenRepo = new DshOrgUnitRepository(null) {
            @Override
            public List<OrgUnit> loadAll() {
                return List.of(
                    new OrgUnit(ROOT, "总公司", null, MAZONG),
                    new OrgUnit(HUADONG, "华东区", ROOT, null),
                    new OrgUnit(DEPT_A, "A部门", HUADONG, ZHANGSAN)
                );
            }
        };
        DshCandidateResolver brokenResolver = new DshCandidateResolver(brokenRepo, memRepo);
        // 张三(A 负责人)parent:A.head==张三→跳过;华东 head=null→报错
        assertThatThrownBy(() -> brokenResolver.resolveForApplicant(
            new AssignmentRule(null, null, "parent", null), DEPT_A, ZHANGSAN))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("华东区").hasMessageContaining("未配置负责人");
    }

    @Test
    void applicantWithoutDepartmentThrows() {
        // 边界:sameLine/虚拟角色而申请人无部门→报错(启动校验的引擎兜底)
        assertThatThrownBy(() -> resolver.resolveForApplicant(
            new AssignmentRule(null, null, "parent", null), null, XIAOWANG))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("分配部门");
        assertThatThrownBy(() -> resolver.resolveForApplicant(
            new AssignmentRule(ROLE_MANAGER, "sameLine", null, null), null, XIAOWANG))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("分配部门");
    }

    @Test
    void emptyDownwardFanOutThrows() {
        // 边界:A 部门无子部门,child 扇出为空→配置错误报错
        assertThatThrownBy(() -> resolver.resolveForApplicant(
            new AssignmentRule(null, null, "child", null), DEPT_A, ZHANGSAN))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("扇出为空");
    }

    @Test
    void sameLineRoleMissingOnWholeLineThrows() {
        // 边界:整条行政线没有该职位→报错(该场景应配虚拟角色)
        DshMembershipRepository emptyRepo = new DshMembershipRepository(null) {
            @Override
            public List<String> findActiveUserIdsByRoleId(String roleId) {
                return List.of();
            }
        };
        DshOrgUnitRepository noMembersRepo = new DshOrgUnitRepository(null) {
            @Override
            public List<OrgUnit> loadAll() {
                return orgRepo.loadAll();
            }

            @Override
            public Map<String, List<String>> findRoleMembersByOrgUnitIds(String roleId, java.util.Collection<String> orgUnitIds) {
                return Map.of();
            }
        };
        DshCandidateResolver noMembersResolver = new DshCandidateResolver(noMembersRepo, emptyRepo);
        assertThatThrownBy(() -> noMembersResolver.resolveForApplicant(
            new AssignmentRule(ROLE_MANAGER, "sameLine", null, null), DEPT_A, XIAOWANG))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("整条行政线");
    }

    @Test
    void fixedUnitEmptySubtreeThrowsAndUnknownUnitThrows() {
        assertThatThrownBy(() -> resolver.resolveForApplicant(
            new AssignmentRule(ROLE_MANAGER, "fixedUnit", null, DEPT_B), null, null))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("没有角色");
        assertThatThrownBy(() -> resolver.resolveForApplicant(
            new AssignmentRule(ROLE_MANAGER, "fixedUnit", null, "unit-unknown"), null, null))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("不存在");
    }

    // ---- §5.2 超时升级(锚定当前审批人) ----

    @Test
    void escalationAnchorsCurrentAssignee() {
        // 双锚点:张三(A 负责人)超时→审批人的上级=老周(而非申请人的上级)
        Resolution r = resolver.resolveForEscalation("parent", DEPT_A, ZHANGSAN);
        assertThat(r.candidates()).containsExactly(LAOZHOU);
    }

    @Test
    void escalationAtTopAutoSignals() {
        // 边界:马总(组织顶点)超时→无处可升(delegate 据此保持原审批人并记审计)
        Resolution r = resolver.resolveForEscalation("parent", ROOT, MAZONG);
        assertThat(r.structuralTopAutoPass()).isTrue();
    }

    @Test
    void nullRuleReturnsNullForLegacyPath() {
        // 存量回归:rule=null→返回 null,调用方维持原逻辑
        assertThat(resolver.resolveForApplicant(null, DEPT_A, XIAOWANG)).isNull();
        // 仅 candidateRoleId(无 orgScope/virtualRole)→global 直查(存量等价)
        assertThat(resolver.resolveForApplicant(new AssignmentRule(ROLE_CFO, null, null, null), DEPT_A, XIAOWANG)
            .candidates()).containsExactlyInAnyOrder(QIANJIE, MAZONG);
    }

    // ---- 决策 13:候选部门归属(dsh_assignment_org_unit 锚点) ----

    @Test
    void parentCarriesHeadDepartmentAsAssignmentOrgUnit() {
        // 小王(A 员工)parent→张三,归属=A 部门(head 所在部门)
        Resolution r = resolver.resolveForApplicant(new AssignmentRule(null, null, "parent", null), DEPT_A, XIAOWANG);
        assertThat(r.assignmentOrgUnits()).containsOnly(Map.entry(ZHANGSAN, DEPT_A));
    }

    @Test
    void sameLineCarriesHitLevelDepartment() {
        // A 无经理成员→命中华东区级,归属=华东区
        roleMembersByUnit.remove(DEPT_A);
        Resolution r = resolver.resolveForApplicant(new AssignmentRule(ROLE_MANAGER, "sameLine", null, null), DEPT_A, XIAOWANG);
        assertThat(r.assignmentOrgUnits()).containsOnly(Map.entry(LAOZHOU, HUADONG));
    }

    @Test
    void childFanOutCarriesEachDepartment() {
        // 扇出各子部门负责人各带自己的部门归属
        Resolution r = resolver.resolveForApplicant(new AssignmentRule(null, null, "child", null), ROOT, MAZONG);
        assertThat(r.assignmentOrgUnits())
            .containsEntry(LAOZHOU, HUADONG)
            .containsEntry(QIANJIE, FINANCE)
            .hasSize(2);
    }

    @Test
    void fixedUnitCarriesFirstSortedDepartmentForMultiDepartmentMember() {
        // 张三同时是 A、B 两个部门的经理成员:候选去重一次,归属取部门 id 排序首个(A)
        roleMembersByUnit.put(DEPT_B, List.of(ZHANGSAN));
        Resolution r = resolver.resolveForApplicant(
            new AssignmentRule(ROLE_MANAGER, "fixedUnit", null, HUADONG), DEPT_A, XIAOWANG);
        assertThat(r.candidates()).containsExactly(ZHANGSAN, LAOZHOU);
        assertThat(r.assignmentOrgUnits())
            .containsEntry(ZHANGSAN, DEPT_A)
            .containsEntry(LAOZHOU, HUADONG);
    }

    @Test
    void globalHasNoAssignmentOrgUnits() {
        // global 场景无部门归属,升级时走映射表回退
        Resolution r = resolver.resolveForApplicant(
            new AssignmentRule(ROLE_CFO, "global", null, null), null, XIAOWANG);
        assertThat(r.candidates()).containsExactlyInAnyOrder(QIANJIE, MAZONG);
        assertThat(r.assignmentOrgUnits()).isEmpty();
    }
}
