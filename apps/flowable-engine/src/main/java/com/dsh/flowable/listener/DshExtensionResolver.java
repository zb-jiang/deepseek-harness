package com.dsh.flowable.listener;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import org.flowable.bpmn.model.BpmnModel;
import org.flowable.bpmn.model.Process;
import org.flowable.bpmn.model.ServiceTask;
import org.flowable.bpmn.model.UserTask;
import org.flowable.engine.RepositoryService;
import org.springframework.stereotype.Component;

/**
 * dsh 扩展元数据解析门面:cache miss 时查 BpmnModel 解析并回填,供
 * {@link DshTaskListener}(task create)与 {@code DshTaskController}(提交端点)共用。
 *
 * <p>三个解析入口:
 * <ul>
 *   <li>{@link #resolveTaskProperties}:userTask 的 dsh 元数据,键 (procdefId, taskDefKey);</li>
 *   <li>{@link #resolveServiceTaskProperties}:serviceTask 的 dsh 元数据(DSH backend task
 *       完整元数据 / 普通自动节点的 votingRule),键 (procdefId, taskDefKey);</li>
 *   <li>{@link #resolveContextVariables}:process 级上下文变量声明,键 procdefId。</li>
 * </ul>
 */
@Component
public class DshExtensionResolver {

    private final RepositoryService repositoryService;
    private final DshBpmnExtensionParser parser;
    private final DshExtensionPropertiesCache cache;

    public DshExtensionResolver(RepositoryService repositoryService,
                                 DshBpmnExtensionParser parser,
                                 DshExtensionPropertiesCache cache) {
        this.repositoryService = repositoryService;
        this.parser = parser;
        this.cache = cache;
    }

    /**
     * 解析 userTask 的 dsh 元数据;cache miss 时查 BpmnModel 解析并回填。
     *
     * @return 元数据;{@code null} 表示节点无 dsh 元素(或 BpmnModel/节点不可用)
     */
    public DshExtensionProperties resolveTaskProperties(String procdefId, String taskDefKey) {
        Optional<DshExtensionProperties> cached = cache.get(procdefId, taskDefKey);
        if (cached != null) {
            return cached.orElse(null);
        }
        BpmnModel bpmnModel = repositoryService.getBpmnModel(procdefId);
        if (bpmnModel == null) {
            // 部署信息不可用,记 empty 避免重复查;部署可能后续才能拿到但 V1 不做更复杂处理
            cache.put(procdefId, taskDefKey, null);
            return null;
        }
        UserTask userTask = findUserTask(bpmnModel, taskDefKey);
        DshExtensionProperties props = userTask == null ? null : parser.parse(userTask);
        if (props != null) {
            List<DshContextVariable> contextVariables = parser.parseContextVariables(findProcess(bpmnModel));
            props = new DshExtensionProperties(
                props.assignmentRule(),
                props.votingRule(),
                props.userPrompt(),
                props.skillRefs(),
                props.actionPolicy(),
                props.outputMappings(),
                contextVariables,
                props.backendTask()
            );
        }
        cache.put(procdefId, taskDefKey, props);
        return props;
    }

    /**
     * 解析 ServiceTask 的 dsh 元数据(design 2026-09-14 §6.1;2026-09-15 三种 task
     * 统一计票后覆盖普通自动节点);cache miss 时查 BpmnModel 解析并回填。
     *
     * <p>DSH backend task(含 {@code dsh:backendTask})返回完整元数据并按 process
     * 级声明合并 contextVariables;普通 ServiceTask 只解析 {@code dsh:votingRule}
     * (计票 end listener 用,无 backendTask/prompt 等概念),无 votingRule 时返回
     * {@code null}。
     *
     * @return 元数据;{@code null} 表示节点无 dsh 元素(普通自动节点未配计票,
     *         或 BpmnModel/节点不可用)
     */
    public DshExtensionProperties resolveServiceTaskProperties(String procdefId, String taskDefKey) {
        Optional<DshExtensionProperties> cached = cache.get(procdefId, taskDefKey);
        if (cached != null) {
            return cached.orElse(null);
        }
        BpmnModel bpmnModel = repositoryService.getBpmnModel(procdefId);
        if (bpmnModel == null) {
            cache.put(procdefId, taskDefKey, null);
            return null;
        }
        ServiceTask serviceTask = findServiceTask(bpmnModel, taskDefKey);
        DshExtensionProperties props = serviceTask == null
            ? null : parser.parseBackendTask(serviceTask);
        if (props == null && serviceTask != null) {
            props = parser.parsePlainServiceTask(serviceTask);
        }
        if (props != null && props.backendTask() != null) {
            List<DshContextVariable> contextVariables = parser.parseContextVariables(findProcess(bpmnModel));
            props = new DshExtensionProperties(
                props.assignmentRule(),
                props.votingRule(),
                props.userPrompt(),
                props.skillRefs(),
                props.actionPolicy(),
                props.outputMappings(),
                contextVariables,
                props.backendTask()
            );
        }
        cache.put(procdefId, taskDefKey, props);
        return props;
    }

    /**
     * 解析 process 级上下文变量声明;cache miss 时查 BpmnModel 解析并回填。
     *
     * @return 声明清单;BpmnModel 不可用时返回空列表(已缓存 empty 不再重复查)
     */
    public List<DshContextVariable> resolveContextVariables(String procdefId) {
        Optional<List<DshContextVariable>> cached = cache.getContext(procdefId);
        if (cached != null) {
            return cached.orElse(List.of());
        }
        List<DshContextVariable> result = null;
        BpmnModel bpmnModel = repositoryService.getBpmnModel(procdefId);
        if (bpmnModel != null) {
            Process process = findProcess(bpmnModel);
            if (process != null) {
                result = parser.parseContextVariables(process);
            }
        }
        cache.putContext(procdefId, result);
        return result == null ? List.of() : result;
    }

    /**
     * 查 userTask 的原始 BPMN 模型元素(SoD 过滤等需要 BPMN 原生
     * candidateUsers/candidateGroups 字段的路径用;常规 dsh 元数据走
     * {@link #resolveTaskProperties} 的 cache)。
     *
     * @return UserTask;BpmnModel 或节点不可用时返回 null
     */
    public UserTask findUserTask(String procdefId, String taskDefKey) {
        BpmnModel bpmnModel = repositoryService.getBpmnModel(procdefId);
        return bpmnModel == null ? null : findUserTask(bpmnModel, taskDefKey);
    }

    private UserTask findUserTask(BpmnModel bpmnModel, String taskDefKey) {
        for (Process process : bpmnModel.getProcesses()) {
            Collection<UserTask> tasks = process.findFlowElementsOfType(UserTask.class);
            for (UserTask t : tasks) {
                if (taskDefKey.equals(t.getId())) {
                    return t;
                }
            }
        }
        return null;
    }

    private ServiceTask findServiceTask(BpmnModel bpmnModel, String taskDefKey) {
        for (Process process : bpmnModel.getProcesses()) {
            Collection<ServiceTask> tasks = process.findFlowElementsOfType(ServiceTask.class);
            for (ServiceTask t : tasks) {
                if (taskDefKey.equals(t.getId())) {
                    return t;
                }
            }
        }
        return null;
    }

    private Process findProcess(BpmnModel bpmnModel) {
        List<Process> processes = bpmnModel.getProcesses();
        return processes == null || processes.isEmpty() ? null : processes.get(0);
    }
}
