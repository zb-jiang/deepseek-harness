package com.dsh.flowable.api;

import com.dsh.flowable.repository.DshApplicationRepository;
import com.dsh.flowable.repository.DshUserRepository;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.flowable.engine.RepositoryService;
import org.flowable.engine.RuntimeService;
import org.flowable.engine.repository.ProcessDefinition;
import org.flowable.engine.runtime.ProcessInstance;
import org.flowable.task.api.Task;
import org.springframework.stereotype.Service;

/**
 * 任务展示元数据批量补齐(员工工作台待办卡片用)。
 *
 * <p>Flowable {@code TaskInfo} 只有 {@code processDefinitionId},没有流程定义名,
 * 也不带实例发起人。员工端待办卡片需要「流程名 + 张三发起」的人读信息,本服务按
 * 任务列表批量补齐四块数据,避免逐任务 N+1:
 * <ul>
 *   <li>流程定义名:distinct procdefId → RepositoryService 批量查
 *       ({@code processDefinitionIds(Set)});</li>
 *   <li>所属应用 id:distinct procdefId → {@code workflow_definitions} JOIN
 *       {@code applications} 一次 IN 查完(员工端凭此定位应用知识库);</li>
 *   <li>实例发起人 id:distinct processInstanceId → RuntimeService 批量查
 *       ({@code processInstanceIds(Set)});REST 启动的生产路径不写 startUserId,
 *       缺失的实例按应用隔离变量 {@code dsh_applicant_user_id} 一次 executionIds
 *       批量回退;</li>
 *   <li>发起人显示名:distinct 发起人 id → {@code platform_users} 反查。</li>
 * </ul>
 *
 * <p>查不到的条目(定义被删、用户已删)对应字段为 {@code null},由前端回退显示。
 */
@Service
public class DshTaskMetaService {

    private final RepositoryService repositoryService;
    private final RuntimeService runtimeService;
    private final DshUserRepository userRepository;
    private final DshApplicationRepository applicationRepository;

    public DshTaskMetaService(RepositoryService repositoryService,
                               RuntimeService runtimeService,
                               DshUserRepository userRepository,
                               DshApplicationRepository applicationRepository) {
        this.repositoryService = repositoryService;
        this.runtimeService = runtimeService;
        this.userRepository = userRepository;
        this.applicationRepository = applicationRepository;
    }

    /**
     * 按任务实例 id 的展示元数据:流程定义名 / 发起人 id / 发起人显示名。
     *
     * @param tasks 当前查询到的任务列表(运行中任务,实例必在 runtime 中)
     * @return processInstanceId → 元数据;流程实例不在 runtime(理论不可能,防御)时缺项
     */
    public Map<String, TaskMeta> enrichByInstance(Collection<Task> tasks) {
        if (tasks == null || tasks.isEmpty()) {
            return Map.of();
        }

        Set<String> procdefIds = new HashSet<>();
        Set<String> instanceIds = new HashSet<>();
        for (Task task : tasks) {
            if (task.getProcessDefinitionId() != null) {
                procdefIds.add(task.getProcessDefinitionId());
            }
            if (task.getProcessInstanceId() != null) {
                instanceIds.add(task.getProcessInstanceId());
            }
        }

        Map<String, String> procdefNameById = new HashMap<>();
        for (ProcessDefinition def : repositoryService.createProcessDefinitionQuery()
                .processDefinitionIds(procdefIds).list()) {
            procdefNameById.put(def.getId(), def.getName());
        }
        // procdefId → 所属应用 id:一次 IN 查完(逐 procdef 单查在远端 DB 上是 N+1)
        Map<String, String> applicationIdByProcdef =
            applicationRepository.findApplicationIdsByProcdefIds(procdefIds);

        Map<String, String> startUserByInstance = new HashMap<>();
        if (!instanceIds.isEmpty()) {
            List<ProcessInstance> instances = runtimeService.createProcessInstanceQuery()
                .processInstanceIds(instanceIds)
                .list();
            // REST 启动的生产路径不写 startUserId,发起人读应用隔离变量
            // dsh_applicant_user_id(流程级变量挂 root execution,executionId = 实例 id);
            // 缺 startUserId 的实例集合一次 executionIds 批量查,不逐实例 getVariable
            Set<String> missingApplicantIds = new HashSet<>();
            for (ProcessInstance instance : instances) {
                if (instance.getStartUserId() != null) {
                    startUserByInstance.put(instance.getId(), instance.getStartUserId());
                } else {
                    missingApplicantIds.add(instance.getId());
                }
            }
            if (!missingApplicantIds.isEmpty()) {
                for (var variable : runtimeService.createVariableInstanceQuery()
                        .executionIds(missingApplicantIds)
                        .variableName("dsh_applicant_user_id")
                        .list()) {
                    Object value = variable.getValue();
                    if (value instanceof String s && !s.isBlank()) {
                        startUserByInstance.putIfAbsent(variable.getExecutionId(), s);
                    }
                }
            }
        }

        Map<String, String> displayNameByUser =
            userRepository.findDisplayNamesByAuthSubjects(new HashSet<>(startUserByInstance.values()));

        Map<String, TaskMeta> metaByInstance = new HashMap<>();
        for (Task task : tasks) {
            String procdefName = task.getProcessDefinitionId() == null
                ? null
                : procdefNameById.get(task.getProcessDefinitionId());
            String applicationId = task.getProcessDefinitionId() == null
                ? null
                : applicationIdByProcdef.get(task.getProcessDefinitionId());
            String startUserId = startUserByInstance.get(task.getProcessInstanceId());
            String startUserName = startUserId == null ? null : displayNameByUser.get(startUserId);
            metaByInstance.put(task.getProcessInstanceId(),
                new TaskMeta(procdefName, startUserId, startUserName, applicationId));
        }
        return metaByInstance;
    }

    /**
     * 单个任务的展示元数据。
     *
     * @param task 任务
     * @return 元数据;task 或其实例 id 为 null 时字段全 null
     */
    public TaskMeta enrich(Task task) {
        if (task == null || task.getProcessInstanceId() == null) {
            return new TaskMeta(null, null, null, null);
        }
        return enrichByInstance(List.of(task)).getOrDefault(
            task.getProcessInstanceId(), new TaskMeta(null, null, null, null));
    }

    /**
     * 任务展示元数据。
     *
     * @param processDefinitionName 流程定义名(BPMN process name);查不到为 null
     * @param startUserId           发起人 auth_subject(Supabase Auth sub);查不到为 null
     * @param startUserName         发起人显示名;未解析到为 null,前端回退显示 id
     * @param applicationId         流程定义所属应用 id(UUID 字符串);员工端凭此定位
     *                              应用知识库;未归属应用(两级归属解析都未命中)为 null
     */
    public record TaskMeta(
        String processDefinitionName,
        String startUserId,
        String startUserName,
        String applicationId
    ) {
    }
}
