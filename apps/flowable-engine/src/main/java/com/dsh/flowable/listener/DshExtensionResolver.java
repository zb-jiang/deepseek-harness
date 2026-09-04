package com.dsh.flowable.listener;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import org.flowable.bpmn.model.BpmnModel;
import org.flowable.bpmn.model.Process;
import org.flowable.bpmn.model.UserTask;
import org.flowable.engine.RepositoryService;
import org.springframework.stereotype.Component;

/**
 * dsh 扩展元数据解析门面:cache miss 时查 BpmnModel 解析并回填,供
 * {@link DshTaskListener}(task create)与 {@code DshTaskController}(提交端点)共用。
 *
 * <p>两个解析入口:
 * <ul>
 *   <li>{@link #resolveTaskProperties}:userTask 的 dsh 元数据,键 (procdefId, taskDefKey);</li>
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
                props.userPrompt(),
                props.skillRefs(),
                props.actionPolicy(),
                props.outputMappings(),
                contextVariables
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

    private Process findProcess(BpmnModel bpmnModel) {
        List<Process> processes = bpmnModel.getProcesses();
        return processes == null || processes.isEmpty() ? null : processes.get(0);
    }
}
