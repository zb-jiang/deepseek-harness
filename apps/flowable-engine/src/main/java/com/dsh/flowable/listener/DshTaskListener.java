package com.dsh.flowable.listener;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.flowable.bpmn.model.UserTask;
import org.flowable.engine.TaskService;
import org.flowable.engine.delegate.TaskListener;
import org.flowable.task.service.delegate.DelegateTask;
import org.springframework.stereotype.Component;
import com.dsh.flowable.repository.DshMembershipRepository;

/**
 * 在 userTask create 事件触发时,做三件事:
 *
 * <ol>
 *   <li><b>注入 dsh 元数据</b>:从 BPMN model 解析节点 {@code dsh:} extensionElements 为
 *       {@link DshExtensionProperties} POJO,JSON 序列化后注入 task-local 变量
 *       {@code dsh_node_meta};task-api 查询待办时一并返回,DSH enterprise profile 用它
 *       取任务指令(userPrompt)与 skill 引用(skillRefs)。</li>
 *   <li><b>userPrompt {@code {{}}} 插值</b>(design 2026-09-01 §7):任务创建时把模板中
 *       {@code {{var.field}}} 占位符替换为流程变量快照——string 直接替换,object/array 序列化为
 *       JSON 文本嵌入,值缺失(变量未设置或路径中途断开)替换为「空」。每个候选人的任务各自持有
 *       创建时刻快照,互不干扰。</li>
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
 * <p><b>缓存策略</b>:解析结果按 {@code (procdefId, taskDefKey)} 缓存在
 * {@link DshExtensionPropertiesCache}(经 {@link DshExtensionResolver} 访问)。
 * cache 存模板原文;插值是每次 task create 的动态步骤,不进 cache。
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

    /** userPrompt 模板占位符 {@code {{var.field}}}(design 2026-09-01 §7)。 */
    private static final Pattern PROMPT_PLACEHOLDER = Pattern.compile("\\{\\{([^}]+)}}");

    private final DshExtensionResolver resolver;
    private final ObjectMapper objectMapper;
    private final DshSodFilter sodFilter;
    private final DshMembershipRepository membershipRepository;
    private final TaskService taskService;

    public DshTaskListener(DshExtensionResolver resolver,
                            ObjectMapper objectMapper,
                            DshSodFilter sodFilter,
                            DshMembershipRepository membershipRepository,
                            TaskService taskService) {
        this.resolver = resolver;
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
        DshExtensionProperties props = resolver.resolveTaskProperties(procdefId, taskDefKey);
        if (props == null) {
            return;
        }
        // 1. userPrompt 插值快照后,注入 dsh 元数据到 task-local 变量
        DshExtensionProperties snapshot = withInterpolatedPrompt(props, delegateTask);
        try {
            String json = objectMapper.writeValueAsString(snapshot);
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
            UserTask userTask = resolver.findUserTask(procdefId, taskDefKey);
            if (userTask != null) {
                applySod(delegateTask, props, userTask);
            }
        }
    }

    /**
     * 对 userPrompt 做 {@code {{}}} 插值;其余字段原样保留。
     */
    private DshExtensionProperties withInterpolatedPrompt(DshExtensionProperties props,
                                                           DelegateTask delegateTask) {
        String template = props.userPrompt();
        if (template == null || template.isBlank()) {
            return props;
        }
        return new DshExtensionProperties(
            props.assignmentRule(),
            interpolate(template, delegateTask),
            props.skillRefs(),
            props.actionPolicy(),
            props.outputMappings(),
            props.contextVariables()
        );
    }

    /**
     * 替换模板中全部 {@code {{var.field}}} 占位符。
     */
    private String interpolate(String template, DelegateTask delegateTask) {
        Matcher matcher = PROMPT_PLACEHOLDER.matcher(template);
        StringBuilder sb = new StringBuilder();
        while (matcher.find()) {
            String path = matcher.group(1).trim();
            matcher.appendReplacement(sb, Matcher.quoteReplacement(resolvePlaceholder(path, delegateTask)));
        }
        matcher.appendTail(sb);
        return sb.toString();
    }

    /**
     * 解析点路径占位符:根段从流程变量取,后续段深入 Map 字段;
     * 值缺失(null 或路径中途断开)替换为「空」——变量未设置常见于分支跳过
     * 未走过的节点,保留占位符原文会把模板语法泄漏给模型与办理人;
     * string 直接替换,其余类型(object/array/数字等)序列化为 JSON 文本嵌入。
     */
    private String resolvePlaceholder(String path, DelegateTask delegateTask) {
        String[] segments = path.split("\\.");
        Object value = delegateTask.getVariable(segments[0]);
        for (int i = 1; i < segments.length && value != null; i++) {
            if (value instanceof Map<?, ?> map) {
                value = map.get(segments[i]);
            } else {
                value = null;
            }
        }
        if (value == null) {
            return "空";
        }
        if (value instanceof String s) {
            return s;
        }
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            return "{{" + path + "}}";
        }
    }

    /**
     * 应用 SoD 规则过滤候选 users,结果写入 task.candidateUsers。
     *
     * <p>多实例任务已由 {@link DshMultiInstanceSetupListener} 在节点 start 时注入
     * collection 变量并直接分配 assignee,本方法跳过,避免重复设置 candidateUsers。</p>
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
        if (userTask.getLoopCharacteristics() != null) {
            return;
        }
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
}
