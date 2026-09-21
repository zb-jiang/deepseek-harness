package com.dsh.flowable.listener;

import com.dsh.flowable.repository.DshMembershipRepository;
import com.dsh.flowable.repository.DshOrgUnitRepository;
import com.dsh.flowable.repository.DshOrgUnitRepository.OrgUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Component;

/**
 * 组织维度候选解析器(design 2026-09-19 §5.2):范围(横坐标) × 目标角色(纵坐标)
 * 组合矩阵的统一实现,三处解析点共用——
 * <ul>
 *   <li>{@link DshMultiInstanceSetupListener}(待办分配,锚定申请人);</li>
 *   <li>{@link DshTaskListener} SoD 路径(非多实例防御覆盖,锚定申请人);</li>
 *   <li>{@code DshTaskEscalationDelegate}(超时升级,锚定当前审批人)。</li>
 * </ul>
 *
 * <p><b>行政线链式模型</b>:从锚点部门(含)逐级向上;每级的「可用负责人」指
 * head_user_id 非空且不等于锚点人(§5.4 跳过锚点人后判空——"自己的审批人永远
 * 不是自己")。虚拟角色:
 * <ul>
 *   <li>parent = 链上第 1 个可用负责人;grandparent = 第 2 个;</li>
 *   <li>链上某级 head 缺失 → 数据缺失报错(不静默);</li>
 *   <li>链耗尽(每级负责人都是锚点人) → 结构到顶,autoPass=true(仅向上语义)。</li>
 * </ul>
 *
 * <p><b>实体角色范围</b>:sameLine 沿链逐级找第一个「该部门内该角色成员减去锚点人
 * 后非空」的级(§5.4 无条件跳过申请人);fixedUnit 取指定部门子树内全部该角色成员;
 * global/缺省 = 全公司(与存量 {@link DshMembershipRepository} 行为一致)。
 *
 * <p><b>候选部门归属</b>:解析结果同时给出每个候选依据的部门(design 决策 13),
 * 派发待办时写任务局部变量 {@code dsh_assignment_org_unit} 作超时升级锚点;
 * virtual/sameLine/fixedUnit 均有明确归属,global 无归属(升级时走映射表回退)。
 *
 * <p><b>边界规则</b>(§5.3):向上的尽头是组织的自然顶点 → 自动通过;其余的空候选
 * (sameLine 整条线无该职位 / 向下扇出为空 / fixedUnit 子树无成员)都是数据或设计
 * 问题,抛 {@link IllegalStateException} 报错不静默。
 */
@Component
public class DshCandidateResolver {

    /**
     * 解析结果:候选流程身份列表 + 候选的部门归属 + 「结构到顶自动通过」信号。
     *
     * @param candidates           候选 auth_subject 列表
     * @param assignmentOrgUnits   assignee → 解析出该 assignee 依据的部门 id
     *                              (design 决策 13:派发时写任务局部变量
     *                              {@code dsh_assignment_org_unit} 作超时升级锚点);
     *                              global 场景无归属为空 Map(升级时走映射表回退)。
     *                              固定部门子树内同一用户多部门命中时取部门 id
     *                              排序遍历的首个,保证结果确定
     * @param structuralTopAutoPass 结构到顶信号(仅向上语义)
     */
    public record Resolution(List<String> candidates,
                             Map<String, String> assignmentOrgUnits,
                             boolean structuralTopAutoPass) {
        static Resolution of(List<String> candidates) {
            return new Resolution(candidates, Map.of(), false);
        }

        static Resolution of(List<String> candidates, Map<String, String> assignmentOrgUnits) {
            return new Resolution(candidates, assignmentOrgUnits, false);
        }

        static Resolution autoPass() {
            return new Resolution(List.of(), Map.of(), true);
        }
    }

    /** 同级行政链向上的防御上限(治理层已防循环引用,纵深防御)。 */
    private static final int MAX_CHAIN_DEPTH = 100;

    private final DshOrgUnitRepository orgUnitRepository;
    private final DshMembershipRepository membershipRepository;

    public DshCandidateResolver(DshOrgUnitRepository orgUnitRepository,
                                DshMembershipRepository membershipRepository) {
        this.orgUnitRepository = orgUnitRepository;
        this.membershipRepository = membershipRepository;
    }

    /**
     * 待办分配解析(锚定申请人)。
     *
     * @param rule                节点 assignmentRule;null 返回 null(调用方维持现状)
     * @param applicantOrgUnitId  申请人主部门 id(实例变量 dsh_applicant_org_unit_id)
     * @param applicantUserId     申请人流程身份(dsh_applicant_user_id,可 null)
     * @return 解析结果;rule 全空(无角色无范围)返回 null
     * @throws IllegalStateException sameLine/虚拟角色而申请人无部门、数据缺失、空扇出、
     *                               整条线无该职位(§5.3 非「到顶」的空候选均报错)
     */
    public Resolution resolveForApplicant(DshExtensionProperties.AssignmentRule rule,
                                          String applicantOrgUnitId,
                                          String applicantUserId) {
        if (rule == null) {
            return null;
        }
        if (rule.virtualRole() != null) {
            return resolveVirtual(rule.virtualRole(), applicantOrgUnitId, applicantUserId);
        }
        if (rule.orgScope() == null || "global".equals(rule.orgScope())) {
            // 缺省/全公司:存量路径,空候选交调用方维持现状(0 实例多实例直接完成)
            if (rule.candidateRoleId() == null) {
                return null;
            }
            return Resolution.of(membershipRepository.findActiveUserIdsByRoleId(rule.candidateRoleId()));
        }
        if ("sameLine".equals(rule.orgScope())) {
            return resolveSameLineRole(rule.candidateRoleId(), applicantOrgUnitId, applicantUserId);
        }
        if ("fixedUnit".equals(rule.orgScope())) {
            return resolveFixedUnitRole(rule.candidateRoleId(), rule.fixedUnitId());
        }
        throw new IllegalStateException("未知的审批范围 orgScope=" + rule.orgScope());
    }

    /**
     * 超时升级解析(锚定当前审批人,§5.2 双锚点:升级=审批人的上级接管)。
     *
     * <p>仅虚拟角色支持(escalateToVirtualRole);锚点部门为 null 时调用方不进入本方法
     * (保持原审批人并记审计,§5.3 升级到顶行)。</p>
     */
    public Resolution resolveForEscalation(String virtualRole,
                                           String anchorOrgUnitId,
                                           String anchorUserId) {
        return resolveVirtual(virtualRole, anchorOrgUnitId, anchorUserId);
    }

    /**
     * 虚拟角色链式解析(含 child/grandchild 向下扇出)。
     */
    private Resolution resolveVirtual(String virtualRole, String anchorOrgUnitId, String anchorUserId) {
        return switch (virtualRole) {
            case "parent" -> resolveUpward(anchorOrgUnitId, anchorUserId, 1);
            case "grandparent" -> resolveUpward(anchorOrgUnitId, anchorUserId, 2);
            case "child" -> resolveDownward(anchorOrgUnitId, anchorUserId, 1);
            case "grandchild" -> resolveDownward(anchorOrgUnitId, anchorUserId, 2);
            default -> throw new IllegalStateException("未知的虚拟角色 virtualRole=" + virtualRole);
        };
    }

    /**
     * 向上找第 {@code targetIndex} 个可用负责人(从锚点部门含起,§5.4 跳过锚点人)。
     */
    private Resolution resolveUpward(String anchorOrgUnitId, String anchorUserId, int targetIndex) {
        List<OrgUnit> chain = chainUp(anchorOrgUnitId);
        int found = 0;
        for (OrgUnit unit : chain) {
            String head = unit.headUserId();
            if (head == null) {
                throw new IllegalStateException(
                    "部门「" + unit.name() + "」未配置负责人,无法解析审批人");
            }
            if (anchorUserId != null && anchorUserId.equals(head)) {
                // 负责人恰是锚点人:该层视为到顶,继续向上(§5.4)
                continue;
            }
            found++;
            if (found == targetIndex) {
                return Resolution.of(List.of(head), Map.of(head, unit.id()));
            }
        }
        // 结构到顶:向上的尽头是组织自然顶点,自动通过(§5.3)
        return Resolution.autoPass();
    }

    /**
     * 向下扇出:锚点部门下 {@code depth} 级(1=直接子部门,2=孙子部门)所有部门的负责人。
     */
    private Resolution resolveDownward(String anchorOrgUnitId, String anchorUserId, int depth) {
        requireAnchor(anchorOrgUnitId, "向下扇出");
        Map<String, OrgUnit> units = unitMap();
        Set<String> currentLevel = new HashSet<>();
        currentLevel.add(anchorOrgUnitId);
        for (int level = 0; level < depth; level++) {
            Set<String> nextLevel = new HashSet<>();
            for (OrgUnit unit : units.values()) {
                if (currentLevel.contains(unit.parentId())) {
                    nextLevel.add(unit.id());
                }
            }
            currentLevel = nextLevel;
        }
        if (currentLevel.isEmpty()) {
            throw new IllegalStateException(
                "向下扇出为空:下级部门不存在(流程配置错误或组织未建全)");
        }
        List<String> heads = new ArrayList<>();
        Map<String, String> orgUnits = new LinkedHashMap<>();
        for (String unitId : sortedIds(currentLevel)) {
            OrgUnit unit = units.get(unitId);
            String head = unit.headUserId();
            if (head == null) {
                throw new IllegalStateException(
                    "部门「" + unit.name() + "」未配置负责人,无法扇出审批人");
            }
            if (anchorUserId == null || !anchorUserId.equals(head)) {
                heads.add(head);
                orgUnits.putIfAbsent(head, unitId);
            }
        }
        if (heads.isEmpty()) {
            throw new IllegalStateException(
                "向下扇出排除申请人本人后为空(下级部门负责人均为申请人)");
        }
        return Resolution.of(List.copyOf(heads), orgUnits);
    }

    /**
     * 实体角色 + 同行政线:沿链逐级找第一个「该部门内该角色成员减去申请人后非空」的级。
     */
    private Resolution resolveSameLineRole(String roleId, String applicantOrgUnitId, String applicantUserId) {
        if (roleId == null) {
            throw new IllegalStateException("同行政线实体角色缺少 candidateRoleId(配置错误)");
        }
        requireAnchor(applicantOrgUnitId, "同行政线");
        List<OrgUnit> chain = chainUp(applicantOrgUnitId);
        Map<String, List<String>> members = orgUnitRepository.findRoleMembersByOrgUnitIds(
            roleId, chain.stream().map(OrgUnit::id).toList());
        for (OrgUnit unit : chain) {
            List<String> levelMembers = new ArrayList<>(
                members.getOrDefault(unit.id(), List.of()));
            levelMembers.remove(applicantUserId);
            if (!levelMembers.isEmpty()) {
                Map<String, String> orgUnits = new LinkedHashMap<>();
                for (String member : levelMembers) {
                    orgUnits.put(member, unit.id());
                }
                return Resolution.of(List.copyOf(levelMembers), orgUnits);
            }
        }
        throw new IllegalStateException(
            "整条行政线上没有配置角色 " + roleId + " 的成员(该场景应配虚拟角色,配实体角色是设计错误)");
    }

    /**
     * 实体角色 + 指定部门:子树内全部该角色成员(不跳申请人,SoD 另行过滤)。
     */
    private Resolution resolveFixedUnitRole(String roleId, String fixedUnitId) {
        if (roleId == null || fixedUnitId == null) {
            throw new IllegalStateException(
                "指定部门范围缺少 candidateRoleId/fixedUnitId(配置错误)");
        }
        Map<String, OrgUnit> units = unitMap();
        if (!units.containsKey(fixedUnitId)) {
            throw new IllegalStateException("指定部门 " + fixedUnitId + " 不存在");
        }
        Set<String> subtree = new HashSet<>();
        collectSubtree(units, fixedUnitId, subtree);
        Map<String, List<String>> members = orgUnitRepository.findRoleMembersByOrgUnitIds(roleId, subtree);
        List<String> all = new ArrayList<>();
        Map<String, String> orgUnits = new LinkedHashMap<>();
        for (String unitId : sortedIds(members.keySet())) {
            for (String member : members.get(unitId)) {
                // 同一用户在子树内多部门命中:候选去重,归属取排序后的首个部门(结果确定)
                if (orgUnits.putIfAbsent(member, unitId) == null) {
                    all.add(member);
                }
            }
        }
        if (all.isEmpty()) {
            throw new IllegalStateException("指定部门子树内没有角色 " + roleId + " 的成员");
        }
        return Resolution.of(List.copyOf(all), orgUnits);
    }

    /** 从锚点部门(含)逐级向上构造行政链;锚点缺失报错(启动校验的引擎兜底)。 */
    private List<OrgUnit> chainUp(String anchorOrgUnitId) {
        requireAnchor(anchorOrgUnitId, "同行政线");
        Map<String, OrgUnit> units = unitMap();
        List<OrgUnit> chain = new ArrayList<>();
        String current = anchorOrgUnitId;
        int depth = 0;
        while (current != null) {
            if (depth++ > MAX_CHAIN_DEPTH) {
                throw new IllegalStateException("组织树存在循环引用(治理数据损坏)");
            }
            OrgUnit unit = units.get(current);
            if (unit == null) {
                throw new IllegalStateException("部门 " + current + " 不存在(组织数据不完整)");
            }
            chain.add(unit);
            current = unit.parentId();
        }
        return chain;
    }

    private void requireAnchor(String anchorOrgUnitId, String scopeName) {
        if (anchorOrgUnitId == null || anchorOrgUnitId.isBlank()) {
            throw new IllegalStateException(
                scopeName + "审批路由要求申请人已分配部门(请先在管理后台分配主部门)");
        }
    }

    /** 全量组织树 → id 索引(每次解析一次全表拉取,部门规模几十级)。 */
    private Map<String, OrgUnit> unitMap() {
        Map<String, OrgUnit> units = new LinkedHashMap<>();
        for (OrgUnit unit : orgUnitRepository.loadAll()) {
            units.put(unit.id(), unit);
        }
        return units;
    }

    /** 部门 id 排序:遍历顺序确定性的来源(扇出/子树展开多部门命中同一人时归属取首个)。 */
    private static List<String> sortedIds(Set<String> ids) {
        return ids.stream().sorted().toList();
    }

    /** DFS 收集指定部门子树(含自身)。 */
    private void collectSubtree(Map<String, OrgUnit> units, String rootId, Set<String> collected) {
        collected.add(rootId);
        for (OrgUnit unit : units.values()) {
            if (rootId.equals(unit.parentId())) {
                collectSubtree(units, unit.id(), collected);
            }
        }
    }
}
