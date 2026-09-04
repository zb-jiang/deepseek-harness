package com.dsh.flowable.listener;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * BPMN {@code dsh:} 元数据 lazy 缓存,避免每次 task create / complete 重新查 BpmnModel + 解析 extensionElements。
 *
 * <p>背景:Flowable 引擎虽然内置 BpmnModelCache(进程级缓存部署后的 BPMN DOM),
 * 但拿到 BpmnModel 后仍需遍历 processes 找 UserTask / Process,
 * 并调用 {@link DshBpmnExtensionParser} 重建 POJO;
 * 在大规模任务并发创建时此开销会累积。本缓存把解析结果
 * 缓存到进程级 Map,首次 miss 解析后回填,后续直接读 cache。
 *
 * <p>两个键空间:
 * <ul>
 *   <li>{@code (procdefId, taskDefKey) → DshExtensionProperties}:userTask 的 dsh 元数据;</li>
 *   <li>{@code procdefId → List&lt;DshContextVariable&gt;}:process 级上下文变量声明。</li>
 * </ul>
 *
 * <p><b>缓存键</b>:task 元数据键为 {@code procdefId + "#" + taskDefKey};context 键为 {@code procdefId}。
 * Flowable 部署新版本时生成新 procdefId,旧版本对应 key 自然不再被引用,GC 后释放;
 * V1 单企业单实例无需显式 invalidate。
 *
 * <p><b>缓存值</b>:用 {@link Optional} 区分"未缓存"(返回 {@code null})与"已缓存但无 dsh 元素"
 * (返回 {@link Optional#empty()})。后者避免每次都 fallback 到 BpmnModel 重新解析(已知无 dsh 元素,
 * 再解析也无意义)。
 *
 * <p><b>线程安全</b>:基于 {@link ConcurrentHashMap}。部署顺序保证 procdefId 在 task create 之前已就绪;
 * 并发 task create 同一节点时若同时 miss,最坏并发解析 N 次并 {@code put} N 次覆盖,
 * 结果幂等(同一 UserTask 多次解析结果一致),无正确性风险。
 */
@Component
public class DshExtensionPropertiesCache {

    private final Map<String, Optional<DshExtensionProperties>> cache = new ConcurrentHashMap<>();
    private final Map<String, Optional<List<DshContextVariable>>> contextCache = new ConcurrentHashMap<>();

    /**
     * 按 (procdefId, taskDefKey) 查缓存。
     *
     * @return 缓存值;{@code Optional.empty()} 表示已缓存但节点无 dsh 元素,
     *         {@code null} 表示尚未缓存(调用方应 fallback 解析后 {@link #put} 回填)
     */
    public Optional<DshExtensionProperties> get(String procdefId, String taskDefKey) {
        if (procdefId == null || taskDefKey == null) {
            return null;
        }
        return cache.get(key(procdefId, taskDefKey));
    }

    /**
     * 回填缓存。{@code props} 为 {@code null} 时记 {@link Optional#empty()},避免后续重复 fallback。
     */
    public void put(String procdefId, String taskDefKey, DshExtensionProperties props) {
        if (procdefId == null || taskDefKey == null) {
            return;
        }
        cache.put(key(procdefId, taskDefKey), Optional.ofNullable(props));
    }

    /**
     * 按 procdefId 查上下文变量声明缓存。
     *
     * @return 缓存值;{@code Optional.empty()} 表示已缓存但无声明,
     *         {@code null} 表示尚未缓存(调用方应 fallback 解析后 {@link #putContext} 回填)
     */
    public Optional<List<DshContextVariable>> getContext(String procdefId) {
        if (procdefId == null) {
            return null;
        }
        return contextCache.get(procdefId);
    }

    /**
     * 回填上下文变量声明缓存。{@code vars} 为 {@code null} 时记 {@code Optional.empty()}。
     */
    public void putContext(String procdefId, List<DshContextVariable> vars) {
        if (procdefId == null) {
            return;
        }
        contextCache.put(procdefId, Optional.ofNullable(vars));
    }

    /**
     * 清空缓存(单元测试用;运行时不调,Flowable 引擎重启后 cache 自然重建)。
     */
    public void clear() {
        cache.clear();
        contextCache.clear();
    }

    /**
     * 当前缓存条目数(观测/测试用)。
     */
    public int size() {
        return cache.size();
    }

    private static String key(String procdefId, String taskDefKey) {
        return procdefId + "#" + taskDefKey;
    }
}
