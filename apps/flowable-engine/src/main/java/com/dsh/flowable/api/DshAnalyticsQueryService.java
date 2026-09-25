package com.dsh.flowable.api;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * 分析聚合查询服务(分析看板「业务分析」tab 的数据层)。
 *
 * <p>JdbcTemplate SQL 直查 {@code ACT_HI_*} 历史表做 group-by/percentile 聚合,聚合下推
 * 数据库——Flowable {@code HistoryService} 链式查询不支持 group-by 聚合,逐条拉内存聚合
 * 在数据量增长后不可行。引擎查自己的历史表不违反「web-console 不碰 ACT_*」的边界约定
 * (该约定约束 web-console 侧;引擎本就持有这些表,且引擎已有 JdbcTemplate 先例)。
 *
 * <p><b>列名</b>:Flowable 7 历史表时长列统一为 {@code DURATION_}(bigint,毫秒;
 * Flowable 6 起由 Activiti 时代的 DURATION_IN_MILLISECOND_ 改名),进行中活动/任务该列
 * 为 NULL——全部聚合显式剔除 NULL 行。列结构依据 flowable-engine jar 内
 * {@code org/flowable/db/create/flowable.h2.create.history.sql}。
 *
 * <p>SQL 兼容性:聚合写法(CASE WHEN 求和、AVG/MAX 忽略 NULL、CAST AS DATE、
 * PERCENTILE_CONT、FULL OUTER JOIN、LIMIT)在 PostgreSQL 与 H2 2.x 上语义一致,
 * 生产(PG)与单测(H2 内存引擎)共用同一套 SQL。时间窗在 Java 侧算好 cutoff
 * Timestamp 传入,不依赖数据库方言的 interval 语法。
 *
 * <p>统一参数:
 * <ul>
 *   <li>{@code days}:统计窗口天数(截至当前时刻);</li>
 *   <li>{@code processDefinitionKeys}:可选;按流程定义 key 集合过滤,跨部署版本聚合
 *       (子查询 {@code PROC_DEF_ID_ IN (SELECT ID_ FROM ACT_RE_PROCDEF WHERE KEY_ IN (…))},
 *       语义对齐 {@link DshHistoryController} 的 key 过滤);null/空集合 = 不过滤。
 *       web-console 侧用单元素集合表达"选定具体流程",用名下应用的全量 key 集合
 *       表达 app_admin 的数据可见范围。</li>
 * </ul>
 */
@Service
public class DshAnalyticsQueryService {

    private final JdbcTemplate jdbcTemplate;

    public DshAnalyticsQueryService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /**
     * 流程实例概览统计:窗口内发起/完成/运行中/终止数 + 已结束实例的端到端时长
     * 均值与 P95。completed/terminated 按 DELETE_REASON_ 是否为空区分。
     */
    public AnalyticsOverviewDto overview(int days, List<String> processDefinitionKeys) {
        Timestamp cutoff = cutoff(days);
        StringBuilder sql = new StringBuilder("""
            SELECT COUNT(*) AS started,
                   COALESCE(SUM(CASE WHEN END_TIME_ IS NULL THEN 1 ELSE 0 END), 0) AS running,
                   COALESCE(SUM(CASE WHEN END_TIME_ IS NOT NULL AND DELETE_REASON_ IS NULL
                                     THEN 1 ELSE 0 END), 0) AS completed,
                   COALESCE(SUM(CASE WHEN END_TIME_ IS NOT NULL AND DELETE_REASON_ IS NOT NULL
                                     THEN 1 ELSE 0 END), 0) AS terminated,
                   AVG(CASE WHEN END_TIME_ IS NOT NULL THEN DURATION_ END) AS avg_duration,
                   PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY CASE WHEN END_TIME_ IS NOT NULL
                       THEN DURATION_ END) AS p95_duration
            FROM ACT_HI_PROCINST
            WHERE START_TIME_ >= ?""");
        List<Object> params = new ArrayList<>();
        params.add(cutoff);
        appendKeyFilter(sql, params, processDefinitionKeys);

        return jdbcTemplate.queryForObject(sql.toString(), (rs, rowNum) -> new AnalyticsOverviewDto(
            rs.getLong("started"),
            rs.getLong("completed"),
            rs.getLong("running"),
            rs.getLong("terminated"),
            toMillis(rs.getObject("avg_duration")),
            toMillis(rs.getObject("p95_duration"))
        ), params.toArray());
    }

    /**
     * 每日吞吐量:发起数按 START_TIME_ 日期聚合,正常完成数按 END_TIME_ 日期聚合,
     * Java 侧按日期合并到同一时间轴(某日只发起未完成/只完成未发起都保留,缺侧补 0),
     * 返回按日期升序。拆成两个简单 group-by 查询而非 SQL 全外连接——聚合行数只有
     * 每天一行,Java 合并成本可忽略,且完全规避 FULL OUTER JOIN 的方言差异。
     */
    public List<DailyVolumeDto> dailyVolumes(int days, List<String> processDefinitionKeys) {
        Timestamp cutoff = cutoff(days);
        Map<String, Long> startedByDay = toDayCountMap(jdbcTemplate.query("""
                        SELECT CAST(START_TIME_ AS DATE) AS stat_date, COUNT(*) AS cnt
                        FROM ACT_HI_PROCINST
                        WHERE START_TIME_ >= ?""" + keyFilterSuffix(processDefinitionKeys)
                        + "\nGROUP BY CAST(START_TIME_ AS DATE)",
            (rs, rowNum) -> Map.entry(rs.getDate("stat_date").toLocalDate().toString(), rs.getLong("cnt")),
            params(cutoff, processDefinitionKeys)));
        Map<String, Long> completedByDay = toDayCountMap(jdbcTemplate.query("""
                        SELECT CAST(END_TIME_ AS DATE) AS stat_date, COUNT(*) AS cnt
                        FROM ACT_HI_PROCINST
                        WHERE END_TIME_ IS NOT NULL AND END_TIME_ >= ? AND DELETE_REASON_ IS NULL""" + keyFilterSuffix(processDefinitionKeys)
                        + "\nGROUP BY CAST(END_TIME_ AS DATE)",
            (rs, rowNum) -> Map.entry(rs.getDate("stat_date").toLocalDate().toString(), rs.getLong("cnt")),
            params(cutoff, processDefinitionKeys)));

        TreeSet<String> allDays = new TreeSet<>();
        allDays.addAll(startedByDay.keySet());
        allDays.addAll(completedByDay.keySet());
        return allDays.stream()
            .map(day -> new DailyVolumeDto(day,
                startedByDay.getOrDefault(day, 0L), completedByDay.getOrDefault(day, 0L)))
            .toList();
    }

    /**
     * 节点活动统计(热力图数据源):ACT_HI_ACTINST 按 ACT_ID_ 分组,剔除进行中
     * (DURATION_ 为 NULL)的行,含 sequenceFlow 连线行(前端按 activityType 区分渲染)。
     * 按执行份数倒序。
     */
    public List<ActivityStatDto> activityStats(int days, List<String> processDefinitionKeys) {
        Timestamp cutoff = cutoff(days);
        StringBuilder sql = new StringBuilder("""
            SELECT ACT_ID_,
                   MAX(ACT_NAME_) AS act_name,
                   MAX(ACT_TYPE_) AS act_type,
                   COUNT(*) AS cnt,
                   AVG(DURATION_) AS avg_duration,
                   MAX(DURATION_) AS max_duration
            FROM ACT_HI_ACTINST
            WHERE START_TIME_ >= ? AND DURATION_ IS NOT NULL""");
        List<Object> params = new ArrayList<>();
        params.add(cutoff);
        appendKeyFilter(sql, params, processDefinitionKeys);
        sql.append("\nGROUP BY ACT_ID_\nORDER BY cnt DESC");

        return jdbcTemplate.query(sql.toString(), (rs, rowNum) -> new ActivityStatDto(
            rs.getString("ACT_ID_"),
            rs.getString("act_name"),
            rs.getString("act_type"),
            rs.getLong("cnt"),
            toMillis(rs.getObject("avg_duration")),
            toMillis(rs.getObject("max_duration"))
        ), params.toArray());
    }

    /**
     * 办理人时效统计:user task 专属。查 ACT_HI_ACTINST 过滤 {@code ACT_TYPE_='userTask'}
     * (该表列结构已确认含 ASSIGNEE_/DURATION_,且单测与生产共用同一建表来源,比
     * ACT_HI_TASKINST 更稳),只统计 assignee 非空且时长已知的已完成任务份数,
     * 按份数倒序限 50。assignee 为 user.id,displayName 由 web-console 侧补齐。
     */
    public List<TaskStatDto> taskStats(int days, List<String> processDefinitionKeys) {
        Timestamp cutoff = cutoff(days);
        StringBuilder sql = new StringBuilder("""
            SELECT ASSIGNEE_,
                   COUNT(*) AS cnt,
                   AVG(DURATION_) AS avg_duration,
                   MAX(DURATION_) AS max_duration
            FROM ACT_HI_ACTINST
            WHERE START_TIME_ >= ? AND ACT_TYPE_ = 'userTask'
              AND ASSIGNEE_ IS NOT NULL AND DURATION_ IS NOT NULL""");
        List<Object> params = new ArrayList<>();
        params.add(cutoff);
        appendKeyFilter(sql, params, processDefinitionKeys);
        sql.append("\nGROUP BY ASSIGNEE_\nORDER BY cnt DESC\nLIMIT 50");

        return jdbcTemplate.query(sql.toString(), (rs, rowNum) -> new TaskStatDto(
            rs.getString("ASSIGNEE_"),
            rs.getLong("cnt"),
            toMillis(rs.getObject("avg_duration")),
            toMillis(rs.getObject("max_duration"))
        ), params.toArray());
    }

    private static boolean hasKeys(List<String> processDefinitionKeys) {
        return processDefinitionKeys != null && !processDefinitionKeys.isEmpty();
    }

    /** 日期 → 计数 映射(每日吞吐两条分组查询共用的转换)。 */
    private static Map<String, Long> toDayCountMap(List<Map.Entry<String, Long>> rows) {
        return rows.stream()
            .collect(java.util.stream.Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));
    }

    /** key 过滤片段(有 key 才拼,否则空串);用于字符串拼接式 SQL。 */
    private static String keyFilterSuffix(List<String> processDefinitionKeys) {
        return hasKeys(processDefinitionKeys) ? keyFilterSql(processDefinitionKeys) : "";
    }

    /** 单 cutoff + 可选 key 集合的参数列表(顺序与 keyFilterSuffix 占位符一致)。 */
    private static Object[] params(Timestamp cutoff, List<String> processDefinitionKeys) {
        if (!hasKeys(processDefinitionKeys)) {
            return new Object[]{cutoff};
        }
        Object[] all = new Object[1 + processDefinitionKeys.size()];
        all[0] = cutoff;
        for (int i = 0; i < processDefinitionKeys.size(); i++) {
            all[1 + i] = processDefinitionKeys.get(i);
        }
        return all;
    }

    /** 有 key 过滤时把子查询片段追加到 SQL 并登记参数(保持参数顺序与占位符一致)。 */
    private static void appendKeyFilter(StringBuilder sql, List<Object> params,
                                        List<String> processDefinitionKeys) {
        if (hasKeys(processDefinitionKeys)) {
            sql.append(keyFilterSql(processDefinitionKeys));
            params.addAll(processDefinitionKeys);
        }
    }

    /**
     * 按 key 集合过滤历史表的子查询片段(历史表均含 PROC_DEF_ID_ 列,直接拼子查询):
     * {@code AND PROC_DEF_ID_ IN (SELECT ID_ FROM ACT_RE_PROCDEF WHERE KEY_ IN (?, …))}。
     * 占位符按入参顺序生成,调用方负责按同一顺序登记参数。
     */
    private static String keyFilterSql(List<String> processDefinitionKeys) {
        String placeholders = String.join(", ", java.util.Collections.nCopies(
            processDefinitionKeys.size(), "?"));
        return " AND PROC_DEF_ID_ IN (SELECT ID_ FROM ACT_RE_PROCDEF WHERE KEY_ IN ("
            + placeholders + "))";
    }

    /** 统计窗口起点(当前时刻往前 days 天);Java 侧计算,避免数据库方言 interval 语法。 */
    private static Timestamp cutoff(int days) {
        return Timestamp.from(Instant.now().minus(days, ChronoUnit.DAYS));
    }

    /** AVG/percentile 结果统一转毫秒 Long;无行时 SQL 聚合返回 NULL,映射为 null。 */
    private static Long toMillis(Object value) {
        return value instanceof Number n ? n.longValue() : null;
    }
}
