package com.dsh.console.workflow;

import com.dsh.console.runtime.FlowableRestClient;
import com.dsh.console.workflow.dto.WorkflowDefinitionDto;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

/**
 * 流程引擎状态守卫:状态流转动作(流程停用/归档、角色停用、成员停用)的共享判定。
 *
 * <p>不落任何引用登记表,判定时实时查 Flowable:
 * <ul>
 *   <li>实例计数按 process definition key 聚合(跨全部部署版本):重新发布走
 *       Flowable 版本化,运行中实例可能挂在旧版本上,按 procdefId 数只能数到当前版本。</li>
 *   <li>角色引用判定逐部署版本进行:只解析"有运行中实例的版本"的 BPMN XML。
 *       旧版本实例已全部结束则其引用不再阻塞角色停用(版本无人执行,引用不生效)。</li>
 *   <li>成员任务计数按 assignee + procdef key:只数已认领任务,
 *       未认领的候选任务可由其他成员认领,不阻塞停用。</li>
 * </ul>
 */
@Component
public class WorkflowInstanceGuard {

    private final WorkflowDefinitionJdbcRepository workflowRepository;
    private final BpmnValidationService validationService;
    private final FlowableRestClient flowableRestClient;

    public WorkflowInstanceGuard(WorkflowDefinitionJdbcRepository workflowRepository,
                                 BpmnValidationService validationService,
                                 FlowableRestClient flowableRestClient) {
        this.workflowRepository = workflowRepository;
        this.validationService = validationService;
        this.flowableRestClient = flowableRestClient;
    }

    /**
     * 解析流程的 process definition key:优先 {@code workflow_definitions.bpmn_process_key}
     * (本地 DB 字段,零远端调用),为空的迁移旧行兜底问引擎一次。
     *
     * <p>调用方(各守卫判定)逐 workflow 循环时,key 获取若走引擎会成 N+1 HTTP
     * (每次引擎再查远端 DB);DB 字段命中时整轮循环零 key 查询。
     */
    private String resolveProcessKey(WorkflowDefinitionDto wf) {
        if (wf.bpmnProcessKey() != null && !wf.bpmnProcessKey().isBlank()) {
            return wf.bpmnProcessKey();
        }
        return flowableRestClient.getProcessDefinitionKey(wf.publishedProcdefId());
    }

    /**
     * 统计流程全部部署版本的运行中实例数。
     *
     * <p>从未发布过(procdefId 为空)返回 0;Flowable 查询失败抛
     * {@link IllegalStateException} 拒绝动作(状态守卫宁可拒绝也不放行)。
     */
    public int runningInstanceCount(WorkflowDefinitionDto wf) {
        if (wf.publishedProcdefId() == null || wf.publishedProcdefId().isBlank()) {
            return 0;
        }
        String key = resolveProcessKey(wf);
        int count = flowableRestClient.countRunningInstancesByProcdefKey(key);
        if (count < 0) {
            throw new IllegalStateException(
                "无法从流程引擎确认「%s」的运行中实例数,已拒绝操作".formatted(wf.name()));
        }
        return count;
    }

    /**
     * 列出因运行中实例而阻止指定角色停用的流程名(应用内非归档流程)。
     *
     * <p>先按 key 快筛掉无运行实例的流程,再逐版本核对:只要任一
     * "有运行中实例的版本"的 BPMN 引用该角色,即视为阻塞。
     *
     * @return 阻塞流程名列表;空列表表示无阻塞
     */
    public List<String> workflowsBlockingRoleDisable(UUID appId, UUID roleId) {
        List<String> blocking = new ArrayList<>();
        for (WorkflowDefinitionDto wf : workflowRepository.listByApp(appId)) {
            if ("archived".equals(wf.status())) {
                continue;
            }
            if (runningInstanceCount(wf) == 0) {
                continue;
            }
            if (referencesRoleInRunningVersions(wf, roleId)) {
                blocking.add(wf.name());
            }
        }
        return blocking;
    }

    /**
     * 统计指定办理人在应用内(非归档流程,跨全部部署版本)的未完成已认领任务数。
     *
     * <p>成员停用守卫用:成员资格失效后看不到该应用待办,名下任务会卡死。
     *
     * @throws IllegalStateException Flowable 查询失败(无法确认,拒绝动作)
     */
    public int countOpenTasksInApp(UUID appId, String authSubject) {
        int total = 0;
        for (WorkflowDefinitionDto wf : workflowRepository.listByApp(appId)) {
            if ("archived".equals(wf.status())
                || wf.publishedProcdefId() == null || wf.publishedProcdefId().isBlank()) {
                continue;
            }
            String key = resolveProcessKey(wf);
            int count = flowableRestClient.countOpenTasksByAssigneeAndProcdefKey(authSubject, key);
            if (count < 0) {
                throw new IllegalStateException(
                    "无法从流程引擎确认「%s」的未完成任务数,已拒绝操作".formatted(wf.name()));
            }
            total += count;
        }
        return total;
    }

    /**
     * 流程的运行中实例所挂版本中,是否有任一版本的 BPMN 引用指定角色。
     */
    private boolean referencesRoleInRunningVersions(WorkflowDefinitionDto wf, UUID roleId) {
        String key = resolveProcessKey(wf);
        for (String procdefId : flowableRestClient.listProcessDefinitionIdsByKey(key)) {
            int count = flowableRestClient.countRunningInstancesByProcdefId(procdefId);
            if (count < 0) {
                throw new IllegalStateException(
                    "无法从流程引擎确认「%s」各版本的运行中实例数,已拒绝操作".formatted(wf.name()));
            }
            if (count == 0) {
                continue;
            }
            String xml = flowableRestClient.getProcessDefinitionBpmnXml(procdefId);
            if (validationService.parseRoleReferences(xml).contains(roleId.toString())) {
                return true;
            }
        }
        return false;
    }
}
