package com.dsh.flowable.delegate.custom;

import com.dsh.flowable.api.DshTaskCompletionService;
import com.dsh.flowable.delegate.ProcessLog;
import com.dsh.flowable.repository.DshUserRepository;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 归档 delegate:发文流程收尾留痕,把标题与逐人会签意见落到流程实例日志。
 * BPMN: flowable:delegateExpression="${dshArchiveDelegate}"
 *
 * <p>意见与人配对:{@code leaderOpinions}(array,提交链路逐实例 append)与
 * {@code dsh_submitters_<节点id>}(array,提交端点逐次追加任务 assignee)由
 * {@link DshTaskCompletionService} 在同一次提交里先后追加,下标一一对应——
 * 意见[i]即提交人[i]的表述,逐条带显示名输出;两者长度不齐(旧实例/映射被清空)
 * 时退回意见整体成册,另输出人工参与名单兜底。
 *
 * <p>不查历史任务表:归档与最后一次提交在同一命令内执行,历史表 END_TIME_ 更新
 * 尚未落库,命令内查询读不到(Flowable 命令缓冲语义),运行时变量无此问题。
 */
@Component("dshArchiveDelegate")
public class ArchiveDelegate implements JavaDelegate {

    private final DshUserRepository userRepository;

    public ArchiveDelegate(DshUserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @Override
    public void execute(DelegateExecution execution) {
        Object title = execution.getVariable("title");
        ProcessLog.log(execution, "归档: 发文《{}》", title);

        List<String> submitterIds = collectSubmitterIds(execution);
        List<?> opinions = execution.getVariable("leaderOpinions") instanceof List<?> l ? l : List.of();

        if (opinions.isEmpty()) {
            ProcessLog.log(execution, "会签意见: 无");
            logParticipants(execution, submitterIds);
            return;
        }
        if (opinions.size() == submitterIds.size()) {
            // 意见与提交人在同一提交链路同次序 append,下标配对,逐条带显示名
            Map<String, String> nameById = userRepository.findDisplayNamesByAuthSubjects(submitterIds);
            for (int i = 0; i < opinions.size(); i++) {
                String id = submitterIds.get(i);
                ProcessLog.log(execution, "会签意见[{}]({}): {}", i + 1,
                        nameById.getOrDefault(id, id), opinions.get(i));
            }
            return;
        }
        // 长度不齐:意见整体成册,人工参与行给出提交人名单兜底
        for (int i = 0; i < opinions.size(); i++) {
            ProcessLog.log(execution, "会签意见[{}]: {}", i + 1, opinions.get(i));
        }
        logParticipants(execution, submitterIds);
    }

    /**
     * 收集本实例全部提交人:所有 {@code dsh_submitters_} 前缀变量(每个人工节点一个)
     * 元素的并集,保持追加次序并去重。发文流程仅会签一个人工节点,即会签提交次序。
     */
    private List<String> collectSubmitterIds(DelegateExecution execution) {
        Set<String> ids = new LinkedHashSet<>();
        for (String name : execution.getVariableNames()) {
            if (!name.startsWith(DshTaskCompletionService.SUBMITTERS_VARIABLE_PREFIX)) {
                continue;
            }
            if (execution.getVariable(name) instanceof List<?> list) {
                for (Object item : list) {
                    if (item instanceof String id && !id.isBlank()) {
                        ids.add(id);
                    }
                }
            }
        }
        return new ArrayList<>(ids);
    }

    /** 人工参与名单:提交人显示名按追加次序 join;无提交人时明确记「无」。 */
    private void logParticipants(DelegateExecution execution, List<String> submitterIds) {
        if (submitterIds.isEmpty()) {
            ProcessLog.log(execution, "人工参与: 无");
            return;
        }
        Map<String, String> nameById = userRepository.findDisplayNamesByAuthSubjects(submitterIds);
        ProcessLog.log(execution, "人工参与: {}", submitterIds.stream()
                .map(id -> nameById.getOrDefault(id, id))
                .collect(Collectors.joining("、")));
    }
}
