package com.dsh.flowable.api;

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
 * 任务列表批量补齐三块数据,避免逐任务 N+1:
 * <ul>
 *   <li>流程定义名:distinct procdefId → RepositoryService 逐个查(单用户待办的
 *       distinct 流程数通常 &lt; 10,单查开销可忽略);</li>
 *   <li>实例发起人 id:distinct processInstanceId → RuntimeService 批量查
 *       ({@code processInstanceIds(Set)});</li>
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

    public DshTaskMetaService(RepositoryService repositoryService,
                               RuntimeService runtimeService,
                               DshUserRepository userRepository) {
        this.repositoryService = repositoryService;
        this.runtimeService = runtimeService;
        this.userRepository = userRepository;
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
        for (String procdefId : procdefIds) {
            ProcessDefinition def = repositoryService.createProcessDefinitionQuery()
                .processDefinitionId(procdefId)
                .singleResult();
            if (def != null) {
                procdefNameById.put(procdefId, def.getName());
            }
        }

        Map<String, String> startUserByInstance = new HashMap<>();
        if (!instanceIds.isEmpty()) {
            List<ProcessInstance> instances = runtimeService.createProcessInstanceQuery()
                .processInstanceIds(instanceIds)
                .list();
            for (ProcessInstance instance : instances) {
                String startUserId = instance.getStartUserId() != null
                    ? instance.getStartUserId()
                    : applicantUserIdFromVariable(instance.getId());
                if (startUserId != null) {
                    startUserByInstance.put(instance.getId(), startUserId);
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
            String startUserId = startUserByInstance.get(task.getProcessInstanceId());
            String startUserName = startUserId == null ? null : displayNameByUser.get(startUserId);
            metaByInstance.put(task.getProcessInstanceId(), new TaskMeta(procdefName, startUserId, startUserName));
        }
        return metaByInstance;
    }

    /**
 * 发起人回退:Flowable {@code startUserId} 仅在启动方经 IdentityService 设置过认证用户时
 * 才有值,web-console 经 REST 启动的生产路径不写该字段;此时读应用隔离变量
 * {@code dsh_applicant_user_id}(启动时按登录人 JWT sub 写入)。
 *
 * @return 申请人 auth_subject;变量缺失或非字符串时 null
 */
private String applicantUserIdFromVariable(String instanceId) {
    Object applicant = runtimeService.getVariable(instanceId, "dsh_applicant_user_id");
    return applicant instanceof String s && !s.isBlank() ? s : null;
}

/**
 * 单个任务的展示元数据。
     *
     * @param task 任务
     * @return 元数据;task 或其实例 id 为 null 时字段全 null
     */
    public TaskMeta enrich(Task task) {
        if (task == null || task.getProcessInstanceId() == null) {
            return new TaskMeta(null, null, null);
        }
        return enrichByInstance(List.of(task)).getOrDefault(
            task.getProcessInstanceId(), new TaskMeta(null, null, null));
    }

    /**
     * 任务展示元数据。
     *
     * @param processDefinitionName 流程定义名(BPMN process name);查不到为 null
     * @param startUserId           发起人 auth_subject(Supabase Auth sub);查不到为 null
     * @param startUserName         发起人显示名;未解析到为 null,前端回退显示 id
     */
    public record TaskMeta(
        String processDefinitionName,
        String startUserId,
        String startUserName
    ) {
    }
}
