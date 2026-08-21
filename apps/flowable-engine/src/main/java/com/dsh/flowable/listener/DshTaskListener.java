package com.dsh.flowable.listener;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import org.flowable.bpmn.model.BpmnModel;
import org.flowable.bpmn.model.Process;
import org.flowable.bpmn.model.UserTask;
import org.flowable.engine.RepositoryService;
import org.flowable.engine.TaskService;
import org.flowable.engine.delegate.TaskListener;
import org.flowable.task.service.delegate.DelegateTask;
import org.springframework.stereotype.Component;
import com.dsh.flowable.repository.DshMembershipRepository;

/**
 * 在 userTask create 事件触发时,做两件事:
 *
 * <ol>
 *   <li><b>注入 dsh 元数据</b>:从 BPMN model 解析节点 {@code dsh:} extensionElements 为
 *       {@link DshExtensionProperties} POJO,JSON 序列化后注入 task-local 变量
 *       {@code dsh_node_meta};task-api 查询待办时一并返回,DSH enterprise profile 用它注入
 *       会话五要素(systemPrompt/userPrompt/inputSchema/outputSchema/skillRefs,SPEC §4.8)。</li>
 *   <li><b>SoD 候选过滤</b>(§6.7 B1):解析 {@code dsh:actionPolicy.sodRules},如果非空:
 *       <ul>
 *         <li>从 BPMN 显式配的 {@code flowable:candidateUsers} 或 {@code dsh:assignmentRule.candidateRoleId}
 *             拿初始候选 users(若只配 candidateGroups,查 {@code public.app_memberships} 拿直接 users)。</li>
 *         <li>调 {@link DshSodFilter} 应用规则(not-applicant / mutex-node)过滤。</li>
 *         <li>把过滤后的 candidates 加入 {@code task.candidateUsers}。</li>
 *       </ul>
 *       V1 不展开角色继承(§6.6 由 DSH task-api 层做);引擎只看直接 role。</li>
 * </ol>
 *
 * <p><b>缓存策略</b>(V1 改进):解析结果按 {@code (procdefId, taskDefKey)} 缓存在
 * {@link DshExtensionPropertiesCache}。首次 task create 时 miss,从 BpmnModel 解析并回填;
 * 后续同节点实例直接读 cache,避免重复调 {@link RepositoryService#getBpmnModel(String)}
 * + 遍历 processes 找 UserTask + {@link DshBpmnExtensionParser#parse} 重建 POJO 的开销。
 *
 * <p>由 {@link DshBpmnParseHandler} 在 BPMN 部署时自动注入到所有 UserTask 的 create event,
 * 通过 {@code delegateExpression="${dshTaskListener}"} 引用本 Spring bean。
 */
@Component("dshTaskListener")
public class DshTaskListener implements TaskListener {

    /** task-local 变量名:存储 DshExtensionProperties 的 JSON 字符串。 */
    public static final String TASK_VARIABLE_DSH_META = "dsh_node_meta";

    /** task-local 变量名:存储 BPMN 节点 definition key。 */
    public static final String TASK_VARIABLE_NODE_ID = "dsh_node_id";

    /** task-local 变量名:标记 SoD 过滤已应用(避免重复)。 */
    public static final String TASK_VARIABLE_SOD_APPLIED = "dsh_sod_applied";

    private final RepositoryService repositoryService;
    private final DshBpmnExtensionParser parser;
    private final DshExtensionPropertiesCache cache;
    private final ObjectMapper objectMapper;
    private final DshSodFilter sodFilter;
    private final DshMembershipRepository membershipRepository;
    private final TaskService taskService;

    public DshTaskListener(RepositoryService repositoryService,
                            DshBpmnExtensionParser parser,
                            DshExtensionPropertiesCache cache,
                            ObjectMapper objectMapper,
                            DshSodFilter sodFilter,
                            DshMembershipRepository membershipRepository,
                            TaskService taskService) {
        this.repositoryService = repositoryService;
        this.parser = parser;
        this.cache = cache;
        this.objectMapper = objectMapper;
        this.sodFilter = sodFilter;
        this.membershipRepository = membershipRepository;
        this.taskService = taskService;
    }

    @Override
    public void notify(DelegateTask delegateTask) {
        if (!EVENTNAME_CREATE.equals(delegateTask.getEventName())) {
            return;
        }
        String procdefId = delegateTask.getProcessDefinitionId();
        String taskDefKey = delegateTask.getTaskDefinitionKey();
        if (procdefId == null || taskDefKey == null) {
            return;
        }
        // 缓存命中直接读;未命中(null)时 fallback 解析并回填
        // 注意:Optional.empty() 表示已缓存但节点无 dsh 元素,直接跳过
        DshExtensionProperties props = resolveProperties(procdefId, taskDefKey);
        if (props == null) {
            return;
        }
        // 1. 注入 dsh 元数据到 task-local 变量
        try {
            String json = objectMapper.writeValueAsString(props);
            delegateTask.setVariableLocal(TASK_VARIABLE_DSH_META, json);
            delegateTask.setVariableLocal(TASK_VARIABLE_NODE_ID, taskDefKey);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(
                "Failed to serialize DSH extension properties for task " + taskDefKey, e);
        }
        // 2. 应用 SoD 过滤(§6.7 B1)
        // SoD 过滤需要原始 UserTask 拿 candidateUsers/candidateGroups,这部分无法纯靠 cache POJO
        // (cache POJO 只存 dsh: 元数据,不含 BPMN 原生 candidateUsers/candidateGroups 字段),
        // 因此仍需查 BpmnModel 拿 UserTask。这是有意的:SoD 过滤属少见路径(仅 actionPolicy.sodRules
        // 非空时触发),不必走 cache;常规任务只读 cache 即可完成元数据注入。
        if (props.actionPolicy() != null
            && props.actionPolicy().sodRules() != null
            && !props.actionPolicy().sodRules().isEmpty()) {
            BpmnModel bpmnModel = repositoryService.getBpmnModel(procdefId);
            if (bpmnModel != null) {
                UserTask userTask = findUserTask(bpmnModel, taskDefKey);
                if (userTask != null) {
                    applySod(delegateTask, props, userTask);
                }
            }
        }
    }

    /**
     * 从 cache 解析节点 dsh 元数据;miss 时 fallback 查 BpmnModel 解析并回填。
     *
     * <p>返回 {@code null} 的两种情况:
     * <ul>
     *   <li>cache 已存 {@link Optional#empty()}(节点无 dsh 元素,本就该跳过);</li>
     *   <li>fallback 后 BPMN 中找不到该 UserTask(理论不应发生,容忍处理)。</li>
     * </ul>
     */
    private DshExtensionProperties resolveProperties(String procdefId, String taskDefKey) {
        Optional<DshExtensionProperties> cached = cache.get(procdefId, taskDefKey);
        if (cached != null) {
            return cached.orElse(null);
        }
        // miss:fallback 查 BpmnModel 解析后回填
        BpmnModel bpmnModel = repositoryService.getBpmnModel(procdefId);
        if (bpmnModel == null) {
            // 部署信息不可用,记 empty 避免重复查;部署可能后续才能拿到但 V1 不做更复杂处理
            cache.put(procdefId, taskDefKey, null);
            return null;
        }
        UserTask userTask = findUserTask(bpmnModel, taskDefKey);
        DshExtensionProperties props = userTask == null ? null : parser.parse(userTask);
        cache.put(procdefId, taskDefKey, props);
        return props;
    }

    /**
     * 应用 SoD 规则过滤候选 users,结果写入 task.candidateUsers。
     *
     * <p>过滤前提:能拿到初始候选 users。优先级:
     * <ol>
     *   <li>BPMN 显式配的 {@code flowable:candidateUsers}(逗号分隔);</li>
     *   <li>{@code dsh:assignmentRule.candidateRoleId} 或 BPMN {@code flowable:candidateGroups}
     *       拿 role_id,查 {@code public.app_memberships} 拿直接 users。</li>
     * </ol>
     * 拿不到候选则跳过 SoD 过滤(SoD 无从下手);task-api 层 complete 时可再校验(B2 兜底)。
     */
    private void applySod(DelegateTask delegateTask, DshExtensionProperties props, UserTask userTask) {
        if (props.actionPolicy() == null
            || props.actionPolicy().sodRules() == null
            || props.actionPolicy().sodRules().isEmpty()) {
            return;
        }
        List<String> candidates = collectCandidates(props, userTask);
        if (candidates.isEmpty()) {
            return;
        }
        String applicantUserId = (String) delegateTask
            .getVariable(DshSodFilter.PROCESS_VARIABLE_APPLICANT_USER_ID);
        List<String> filtered = sodFilter.filter(
            candidates,
            props.actionPolicy().sodRules(),
            delegateTask.getProcessInstanceId(),
            delegateTask.getTaskDefinitionKey(),
            applicantUserId
        );
        String taskId = delegateTask.getId();
        for (String userId : filtered) {
            taskService.addCandidateUser(taskId, userId);
        }
        delegateTask.setVariableLocal(TASK_VARIABLE_SOD_APPLIED, "true");
    }

    private List<String> collectCandidates(DshExtensionProperties props, UserTask userTask) {
        // 优先用 BPMN 显式配的 candidateUsers
        List<String> bpmnCandidateUsers = userTask.getCandidateUsers();
        if (bpmnCandidateUsers != null && !bpmnCandidateUsers.isEmpty()) {
            return bpmnCandidateUsers;
        }
        // 否则从 dsh:assignmentRule.candidateRoleId 或 BPMN candidateGroups 拿 role_id,查 app_memberships
        String roleId = props.assignmentRule() != null
            ? props.assignmentRule().candidateRoleId() : null;
        if (roleId == null || roleId.isBlank()) {
            List<String> candidateGroups = userTask.getCandidateGroups();
            if (candidateGroups != null && !candidateGroups.isEmpty()) {
                roleId = candidateGroups.get(0);
            }
        }
        if (roleId == null || roleId.isBlank()) {
            return List.of();
        }
        return membershipRepository.findActiveUserIdsByRoleId(roleId);
    }

    private UserTask findUserTask(BpmnModel bpmnModel, String taskDefKey) {
        List<Process> processes = bpmnModel.getProcesses();
        if (processes == null || processes.isEmpty()) {
            return null;
        }
        for (Process process : processes) {
            Collection<UserTask> tasks = process.findFlowElementsOfType(UserTask.class);
            for (UserTask t : tasks) {
                if (taskDefKey.equals(t.getId())) {
                    return t;
                }
            }
        }
        return null;
    }
}
