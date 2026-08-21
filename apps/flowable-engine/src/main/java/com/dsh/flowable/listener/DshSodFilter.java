package com.dsh.flowable.listener;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import org.flowable.engine.HistoryService;
import org.flowable.task.api.history.HistoricTaskInstance;
import org.springframework.stereotype.Component;

/**
 * 应用职责分离(SoD)规则过滤候选 users(SPEC §6.7 B1)。
 *
 * <p>由 {@link DshTaskListener} 在 task create 时调用:解析节点 {@code dsh:actionPolicy.sodRules},
 * 对候选 user 列表应用规则后过滤,结果写入 {@code task.candidateUsers}。
 *
 * <p>V1 实现的规则类型:
 * <ul>
 *   <li>{@code not-applicant}:排除实例申请人 user.id(从实例变量 {@code dsh_applicant_user_id} 拿);
 *       避免"自己审批自己提交的申请"。</li>
 *   <li>{@code mutex-node}:排除同实例其他节点已完成的 assignee;
 *       实现"同一实例的互斥节点不能由同一人处理"(V1 全局互斥,不区分节点对)。</li>
 * </ul>
 *
 * <p>V1 未实现:{@code countersign-distinct}(multi-instance 会签已处理人不重复);
 * 涉及 {@code act_hi_varinst} 等复杂查询,V2 补。
 *
 * <p>过滤前提:候选列表已通过 {@link DshMembershipRepository} 拿到直接 role 下的 users,
 * 或 BPMN 显式配了 {@code flowable:candidateUsers}。无候选时 SoD 过滤无从下手,直接返回空。
 */
@Component
public class DshSodFilter {

    /** 实例变量名:存储申请人 user.id(由流程发起方在 start 时传入)。 */
    public static final String PROCESS_VARIABLE_APPLICANT_USER_ID = "dsh_applicant_user_id";

    private final HistoryService historyService;

    public DshSodFilter(HistoryService historyService) {
        this.historyService = historyService;
    }

    /**
     * 应用 SoD 规则过滤候选 users。
     *
     * @param candidates         初始候选 user id 列表(来自 BPMN candidateUsers 或 app_memberships 查询)
     * @param sodRules           SoD 规则列表(来自 {@code dsh:actionPolicy.sodRules})
     * @param processInstanceId  实例 id(mutex-node 查历史 task 用)
     * @param currentTaskDefKey  当前节点 def key(mutex-node 排除自身)
     * @param applicantUserId    申请人 user id(not-applicant 用,从实例变量拿;nullable 表示无申请人约束)
     * @return 过滤后的候选 user id 列表
     */
    public List<String> filter(
        List<String> candidates,
        List<DshExtensionProperties.SodRule> sodRules,
        String processInstanceId,
        String currentTaskDefKey,
        String applicantUserId
    ) {
        if (candidates == null || candidates.isEmpty()) {
            return List.of();
        }
        if (sodRules == null || sodRules.isEmpty()) {
            return candidates;
        }
        List<String> filtered = new ArrayList<>(candidates);
        for (DshExtensionProperties.SodRule rule : sodRules) {
            if (rule == null || rule.type() == null) {
                continue;
            }
            switch (rule.type()) {
                case "not-applicant" -> filtered = filterNotApplicant(filtered, applicantUserId);
                case "mutex-node" -> filtered = filterMutexNode(filtered, processInstanceId, currentTaskDefKey);
                case "countersign-distinct" -> {
                    // V1 deferred:multi-instance 已处理人查询,V2 补
                }
                default -> {
                    // V1 不识别的 SoD 规则类型,跳过(不报错)
                }
            }
        }
        return List.copyOf(filtered);
    }

    /**
     * not-applicant:从候选中排除申请人 user.id。
     *
     * <p>避免"自己审批自己提交的申请";申请人在 start 流程时由发起方写入实例变量
     * {@link #PROCESS_VARIABLE_APPLICANT_USER_ID}。
     */
    private List<String> filterNotApplicant(List<String> candidates, String applicantUserId) {
        if (applicantUserId == null || applicantUserId.isBlank()) {
            return candidates;
        }
        return candidates.stream()
            .filter(u -> !applicantUserId.equals(u))
            .toList();
    }

    /**
     * mutex-node:从候选中排除同实例其他节点已完成 task 的 assignee。
     *
     * <p>V1 全局互斥:本节点的候选 user 中,任何已在本实例其他节点完成过 task 的 user 都被排除。
     * V2 可加 attribute {@code mutexWith=nodeId} 指定具体互斥节点对。
     */
    private List<String> filterMutexNode(List<String> candidates, String processInstanceId, String currentTaskDefKey) {
        if (processInstanceId == null) {
            return candidates;
        }
        Set<String> excludeUsers = new HashSet<>();
        List<HistoricTaskInstance> completedTasks = historyService.createHistoricTaskInstanceQuery()
            .processInstanceId(processInstanceId)
            .finished()
            .list();
        for (HistoricTaskInstance t : completedTasks) {
            if (!Objects.equals(t.getTaskDefinitionKey(), currentTaskDefKey)) {
                String assignee = t.getAssignee();
                if (assignee != null && !assignee.isBlank()) {
                    excludeUsers.add(assignee);
                }
            }
        }
        if (excludeUsers.isEmpty()) {
            return candidates;
        }
        return candidates.stream()
            .filter(u -> !excludeUsers.contains(u))
            .toList();
    }
}
