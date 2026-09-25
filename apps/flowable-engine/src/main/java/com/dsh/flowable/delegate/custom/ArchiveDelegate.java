package com.dsh.flowable.delegate.custom;

import com.dsh.flowable.delegate.ProcessLog;
import com.dsh.flowable.repository.DshUserRepository;

import org.flowable.engine.HistoryService;
import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.flowable.task.api.history.HistoricTaskInstance;
import org.springframework.stereotype.Component;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 归档 delegate:发文流程收尾留痕,把标题/摘要、多实例会签意见聚合与人工参与名单落到流程实例日志。
 * BPMN: flowable:delegateExpression="${dshArchiveDelegate}"
 *
 * <p>会签意见来自 {@code leaderOpinions}(array,员工提交链路逐实例 append,
 * 见 {@code DshTaskCompletionService} 的 array 聚合);参与名单按本实例已完成
 * 历史任务的 assignee 去重后反查显示名。意见与参与人分别成册、不逐人配对——
 * 并行提交的 append 顺序与任务完成顺序在并发下不保证一致。
 */
@Component("dshArchiveDelegate")
public class ArchiveDelegate implements JavaDelegate {

    private final HistoryService historyService;
    private final DshUserRepository userRepository;

    public ArchiveDelegate(HistoryService historyService, DshUserRepository userRepository) {
        this.historyService = historyService;
        this.userRepository = userRepository;
    }

    @Override
    public void execute(DelegateExecution execution) {
        Object title = execution.getVariable("title");
        ProcessLog.log(execution, "归档: 发文《{}》", title);

        Object opinions = execution.getVariable("leaderOpinions");
        if (opinions instanceof List<?> list && !list.isEmpty()) {
            for (int i = 0; i < list.size(); i++) {
                ProcessLog.log(execution, "会签意见[{}]: {}", i + 1, list.get(i));
            }
        } else {
            ProcessLog.log(execution, "会签意见: 无");
        }

        Set<String> assignees = collectAssignees(execution.getProcessInstanceId());
        if (assignees.isEmpty()) {
            ProcessLog.log(execution, "人工参与: 无");
            return;
        }
        Map<String, String> nameById = userRepository.findDisplayNamesByAuthSubjects(assignees);
        ProcessLog.log(execution, "人工参与: {}", assignees.stream()
                .map(id -> nameById.getOrDefault(id, id))
                .collect(Collectors.joining("、")));
    }

    /** 本实例全部已完成人工任务的 assignee 去重(保持查询返回顺序)。 */
    private Set<String> collectAssignees(String processInstanceId) {
        Set<String> assignees = new LinkedHashSet<>();
        for (HistoricTaskInstance task : historyService.createHistoricTaskInstanceQuery()
                .processInstanceId(processInstanceId)
                .finished()
                .list()) {
            if (task.getAssignee() != null && !task.getAssignee().isBlank()) {
                assignees.add(task.getAssignee());
            }
        }
        return assignees;
    }
}
