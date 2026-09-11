package com.dsh.flowable.api;

import com.dsh.flowable.listener.DshBpmnExtensionParser;
import com.dsh.flowable.listener.DshExtensionProperties;
import com.dsh.flowable.listener.DshTaskListener;
import com.dsh.flowable.repository.DshApplicationRepository;
import com.dsh.flowable.repository.DshMembershipRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.flowable.bpmn.model.BpmnModel;
import org.flowable.bpmn.model.Process;
import org.flowable.bpmn.model.UserTask;
import org.flowable.engine.RepositoryService;
import org.flowable.engine.TaskService;
import org.flowable.engine.repository.ProcessDefinition;
import org.flowable.task.api.Task;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 员工端 skill 预装扫描 API。
 *
 * <p>daemon 周期调用 {@code GET /dsh/skills/required},获得该用户「现在 + 将来」
 * 需要的 skill 清单(skill-repo-design §6.1):active-task 来源查当前待办的
 * dsh:skillRef;deployed-definition 来源静态解析全部最新已部署流程定义,候选角色
 * 或超时升级目标命中该用户的 userTask 的 skillRef 计入(串签后续节点当前尚无
 * 待办,静态解析保证提前预装)。身份取 JWT {@code sub}(auth_subject),不接受
 * 查询参数指名,防任意用户探测他人清单。
 */
@RestController
@RequestMapping("/dsh/skills")
public class DshSkillController {

    private final TaskService taskService;
    private final RepositoryService repositoryService;
    private final ObjectMapper objectMapper;
    private final DshBpmnExtensionParser extensionParser;
    private final DshMembershipRepository membershipRepository;
    private final DshApplicationRepository applicationRepository;

    public DshSkillController(TaskService taskService,
                              RepositoryService repositoryService,
                              ObjectMapper objectMapper,
                              DshBpmnExtensionParser extensionParser,
                              DshMembershipRepository membershipRepository,
                              DshApplicationRepository applicationRepository) {
        this.taskService = taskService;
        this.repositoryService = repositoryService;
        this.objectMapper = objectMapper;
        this.extensionParser = extensionParser;
        this.membershipRepository = membershipRepository;
        this.applicationRepository = applicationRepository;
    }

    /** 单个 skill 的聚合中间态。 */
    private static class SkillAccumulator {
        String namespace;
        final Set<String> sources = new java.util.LinkedHashSet<>();
    }

    /**
     * 当前用户需要的 skill 清单。
     */
    @GetMapping("/required")
    public Map<String, List<SkillRequirementDto>> required(@AuthenticationPrincipal Jwt jwt) {
        String userId = jwt.getSubject();
        Map<String, SkillAccumulator> acc = new LinkedHashMap<>();

        // 1) active-task:当前待办的 dsh:skillRef
        List<Task> tasks = taskService.createTaskQuery()
            .taskAssignee(userId)
            .includeTaskLocalVariables()
            .list();
        Map<String, String> namespaceByProcdef = new java.util.HashMap<>();
        for (Task task : tasks) {
            DshExtensionProperties props = readMeta(task);
            if (props == null || props.skillRefs().isEmpty()) {
                continue;
            }
            String namespace = namespaceByProcdef.computeIfAbsent(
                task.getProcessDefinitionId(), applicationRepository::findSkillhubNamespaceByProcdefId);
            for (String skill : props.skillRefs()) {
                add(acc, skill, namespace, "active-task");
            }
        }

        // 2) deployed-definition:全部最新定义的静态解析(候选角色/升级目标命中)
        Set<String> userRoleIds = membershipRepository.findActiveRoleIdsByUserSubject(userId);
        List<ProcessDefinition> definitions = repositoryService.createProcessDefinitionQuery()
            .latestVersion()
            .list();
        for (ProcessDefinition definition : definitions) {
            BpmnModel model;
            try {
                model = repositoryService.getBpmnModel(definition.getId());
            } catch (RuntimeException e) {
                // 单个定义解析失败不影响整体清单(如历史脏数据);预装是尽力而为
                continue;
            }
            if (model == null) {
                continue;
            }
            String namespace = namespaceByProcdef.computeIfAbsent(
                definition.getId(), applicationRepository::findSkillhubNamespaceByProcdefId);
            for (Process process : model.getProcesses()) {
                for (UserTask userTask : process.findFlowElementsOfType(UserTask.class)) {
                    DshExtensionProperties props = extensionParser.parse(userTask);
                    if (props == null || props.skillRefs().isEmpty()) {
                        continue;
                    }
                    if (!userMatches(props, userId, userRoleIds)) {
                        continue;
                    }
                    for (String skill : props.skillRefs()) {
                        add(acc, skill, namespace, "deployed-definition");
                    }
                }
            }
        }

        List<SkillRequirementDto> skills = acc.entrySet().stream()
            .map(e -> new SkillRequirementDto(
                e.getKey(), e.getValue().namespace, List.copyOf(e.getValue().sources)))
            .toList();
        return Map.of("skills", skills);
    }

    /**
     * 解析待办 task-local 变量 {@code dsh_node_meta} 为扩展属性;缺失/损坏返回 null
     * (单待办损坏不阻断清单)。
     */
    private DshExtensionProperties readMeta(Task task) {
        Object meta = task.getTaskLocalVariables().get(DshTaskListener.TASK_VARIABLE_DSH_META);
        if (!(meta instanceof String json)) {
            return null;
        }
        try {
            return objectMapper.readValue(json, DshExtensionProperties.class);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 已部署定义的 userTask 是否命中该用户:候选角色、超时升级目标角色为用户
     * 绑定角色之一,或超时升级目标用户即该用户。
     */
    private boolean userMatches(DshExtensionProperties props, String userId, Set<String> userRoleIds) {
        if (props.assignmentRule() != null
            && userRoleIds.contains(props.assignmentRule().candidateRoleId())) {
            return true;
        }
        if (props.actionPolicy() != null && props.actionPolicy().timeoutPolicy() != null) {
            DshExtensionProperties.TimeoutPolicy timeout = props.actionPolicy().timeoutPolicy();
            if (timeout.escalateToRoleId() != null
                && userRoleIds.contains(timeout.escalateToRoleId())) {
                return true;
            }
            return userId.equals(timeout.escalateToUserId());
        }
        return false;
    }

    private static void add(Map<String, SkillAccumulator> acc, String skill,
                            String namespace, String source) {
        SkillAccumulator entry = acc.computeIfAbsent(skill, k -> new SkillAccumulator());
        if (entry.namespace == null && namespace != null) {
            entry.namespace = namespace;
        }
        entry.sources.add(source);
    }
}
