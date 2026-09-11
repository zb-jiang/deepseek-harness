package com.dsh.console;

import com.sun.jna.NativeLibrary;
import com.sun.jna.Platform;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.jar.JarFile;
import java.util.jar.JarInputStream;
import java.util.regex.Pattern;

/**
 * OCR 原生库(tess4j/lept4j 打包在 jar 内的 DLL)启动预加载,仅服务 fat jar 运行形态。
 *
 * <p>fat jar(BOOT-INF/lib 嵌套 jar)里 JNA 按资源名取 DLL 不可靠,启动时统一提取到固定
 * 磁盘目录,设 {@code jna.library.path} 并按依赖顺序预加载;IDE/展开 classpath 形态下
 * JNA 自行解包可靠,本类不做任何事。必须在 JNA 首次使用前执行
 * (即 {@link ConsoleApplication#main} 早期)。DLL 文件名随 tess4j/lept4j 版本变化
 * (如 libtesseract553.dll / libleptonica1870.dll),提取与加载均按内容动态发现。
 */
public final class NativeLibs {

    /** 携带 OCR 原生 DLL 的嵌套 jar(位于 fat jar 的 BOOT-INF/lib 下)。 */
    private static final Pattern NATIVE_JAR = Pattern.compile("BOOT-INF/lib/(lept4j|tess4j)-[0-9].*\\.jar");

    /** 提取出的 DLL 中 leptonica 与 tesseract 的识别;tesseract 的加载依赖 leptonica 先行。 */
    private static final Pattern LEPTONICA_DLL = Pattern.compile("(?i).*lept.*\\.dll");
    private static final Pattern TESSERACT_DLL = Pattern.compile("(?i).*tesseract.*\\.dll");

    private NativeLibs() {
    }

    /**
     * 提取原生库并预加载。非 Windows 平台无事可做;非 fat jar 形态也直接返回。
     */
    public static void preload() {
        if (!Platform.isWindows()) {
            return;
        }
        File fatJar = locateFatJar();
        if (fatJar == null) {
            return;
        }
        Path dir = Path.of(System.getProperty("java.io.tmpdir"), "dsh-web-console-native", Platform.RESOURCE_PREFIX);
        try {
            Files.createDirectories(dir);
            List<Path> extracted = new ArrayList<>();
            extractFromNestedJars(fatJar, dir, extracted);
            if (extracted.stream().noneMatch(p -> LEPTONICA_DLL.matcher(p.getFileName().toString()).matches())
                || extracted.stream().noneMatch(p -> TESSERACT_DLL.matcher(p.getFileName().toString()).matches())) {
                throw new IllegalStateException(
                    "fat jar 内未找到 leptonica/tesseract 原生库:" + fatJar);
            }
            System.setProperty("jna.library.path", dir.toString());
            for (Pattern pattern : List.of(LEPTONICA_DLL, TESSERACT_DLL)) {
                for (Path dll : extracted) {
                    if (pattern.matcher(dll.getFileName().toString()).matches()) {
                        String name = dll.getFileName().toString();
                        NativeLibrary.getInstance(name.substring(0, name.length() - 4));
                    }
                }
            }
        } catch (Exception e) {
            throw new IllegalStateException("OCR 原生库提取/预加载失败(" + dir + ")", e);
        }
    }

    /**
     * 定位自身所在的 fat jar;返回 null 表示非 fat jar 形态(IDE 展开 classpath 或目录运行)。
     */
    private static File locateFatJar() {
        URL location = NativeLibs.class.getProtectionDomain().getCodeSource().getLocation();
        if (!"jar".equals(location.getProtocol())) {
            return null;
        }
        try {
            // fat jar 形态的外层 jar 定位,兼容两种嵌套格式:
            // Boot 3.2+: jar:nested:/.../app.jar/!BOOT-INF/classes!/(分隔符 /!)
            // Boot 3.1-: jar:file:/.../app.jar!/BOOT-INF/classes/  (分隔符 /!)
            String spec = location.toExternalForm();
            int bang = spec.indexOf('!');
            if (bang <= 4) {
                throw new IllegalStateException("fat jar 地址缺少嵌套分隔符:" + spec);
            }
            String outer = spec.substring(4, bang)
                .replaceFirst("^(nested:|file:)", "")
                .replaceFirst("/$", "");
            return Path.of(new URL("file:" + outer).toURI()).toFile();
        } catch (IllegalStateException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("无法解析 fat jar 位置:" + location, e);
        }
    }

    /**
     * 从 fat jar 的 BOOT-INF/lib 嵌套 jar(lept4j/tess4j)提取平台目录下全部 DLL。
     * 用 JarFile 双层解析,不依赖 classloader 的嵌套资源枚举。
     */
    private static void extractFromNestedJars(File fatJar, Path dir, List<Path> extracted) throws IOException {
        try (JarFile bootJar = new JarFile(fatJar)) {
            List<String> libJars = bootJar.stream()
                .map(entry -> entry.getName())
                .filter(name -> NATIVE_JAR.matcher(name).matches())
                .toList();
            for (String libJar : libJars) {
                try (InputStream libStream = bootJar.getInputStream(bootJar.getJarEntry(libJar));
                     var nested = new JarInputStream(libStream)) {
                    for (var entry = nested.getNextJarEntry();
                         entry != null;
                         entry = nested.getNextJarEntry()) {
                        String name = entry.getName();
                        if (name.startsWith(Platform.RESOURCE_PREFIX + "/") && name.endsWith(".dll")) {
                            Path target = dir.resolve(name.substring(name.lastIndexOf('/') + 1));
                            writeIfChanged(nested.readAllBytes(), target);
                            extracted.add(target);
                        }
                    }
                }
            }
        }
    }

    /**
     * 写入提取的 DLL。同名同大小视为已就位(重复启动跳过);大小不同说明版本升级,
     * 覆盖写入——若被仍在运行的旧进程占用,这里抛出并 fail loud。
     */
    private static void writeIfChanged(byte[] bytes, Path target) throws IOException {
        if (Files.exists(target) && Files.size(target) == bytes.length) {
            return;
        }
        Files.write(target, bytes);
    }
}
