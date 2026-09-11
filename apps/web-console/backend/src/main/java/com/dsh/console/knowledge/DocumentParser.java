package com.dsh.console.knowledge;

import com.dsh.console.config.KnowledgeProperties;
import java.awt.Color;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Set;
import javax.imageio.ImageIO;
import net.sourceforge.tess4j.Tesseract;
import org.apache.tika.metadata.Metadata;
import org.apache.tika.metadata.TikaCoreProperties;
import org.apache.tika.parser.AutoDetectParser;
import org.apache.tika.parser.ParseContext;
import org.apache.tika.sax.BodyContentHandler;
import org.springframework.stereotype.Component;

/**
 * 文档文本抽取:按扩展名分流——纯文本直读、图片 OCR(tess4j + chi_sim/eng)、
 * pdf/office 等走 Tika 自动识别;无法识别的类型返回 null(仅按名称检索)。
 *
 * <p>只在解析管线单线程内调用,不保证多线程安全。OCR 依赖 TESSDATA_PATH 训练数据
 * (setup guide §12.3),未配置时抛出并使该文档解析标记 failed,不阻塞其他文档。
 */
@Component
public class DocumentParser {

    /** 直读 UTF-8 文本。 */
    private static final Set<String> PLAIN_EXTENSIONS = Set.of("txt", "md", "markdown", "csv", "log", "json");
    /** OCR 图片。 */
    private static final Set<String> IMAGE_EXTENSIONS = Set.of("png", "jpg", "jpeg", "bmp", "gif", "tif", "tiff", "webp");
    /** Tika 抽取(pdf / office / open文档 / rtf / html / epub)。 */
    private static final Set<String> TIKA_EXTENSIONS =
        Set.of("pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "html", "htm", "epub");

    private final KnowledgeProperties properties;

    public DocumentParser(KnowledgeProperties properties) {
        this.properties = properties;
    }

    /**
     * 抽取文本。
     *
     * @param name    文档名(取扩展名分流)
     * @param content 文件字节
     * @return 抽取文本;类型不可抽取时为 null(调用方记 ready + 空文本,仅名称可检索)
     * @throws Exception 解析失败(OCR 缺训练数据 / 文件损坏等),由管线标记 failed
     */
    public String extract(String name, byte[] content) throws Exception {
        String extension = extensionOf(name);
        if (IMAGE_EXTENSIONS.contains(extension)) {
            return ocr(content);
        }
        if (PLAIN_EXTENSIONS.contains(extension)) {
            return new String(content, StandardCharsets.UTF_8);
        }
        if (TIKA_EXTENSIONS.contains(extension)) {
            return tikaExtract(name, content);
        }
        return null;
    }

    private String ocr(byte[] content) throws Exception {
        if (!properties.ocrEnabled()) {
            throw new IllegalStateException("未配置 TESSDATA_PATH,无法 OCR 图片文档(setup guide §12.3)");
        }
        for (String language : new String[] {"chi_sim", "eng"}) {
            if (!Files.exists(Path.of(properties.tessdataPath(), language + ".traineddata"))) {
                throw new IllegalStateException(
                    "TESSDATA_PATH(" + properties.tessdataPath() + ")缺少 " + language + ".traineddata(setup guide §12.3)");
            }
        }
        var image = ImageIO.read(new ByteArrayInputStream(content));
        if (image == null) {
            throw new IllegalStateException("无法解码图片文件");
        }
        // 带 alpha 通道(PNG 海报常见)的图像类型走 Leptonica 转换会触发 native 段错误
        // (Invalid memory access at TessBaseAPIGetUTF8Text);白底重绘为不透明 RGB,
        // 同时让透明底上的文字合成到白色背景,识别率更好。
        var rgb = new BufferedImage(image.getWidth(), image.getHeight(), BufferedImage.TYPE_INT_RGB);
        var graphics = rgb.createGraphics();
        try {
            graphics.setColor(Color.WHITE);
            graphics.fillRect(0, 0, rgb.getWidth(), rgb.getHeight());
            graphics.drawImage(image, 0, 0, null);
        } finally {
            graphics.dispose();
        }
        Tesseract tesseract = new Tesseract();
        tesseract.setDatapath(properties.tessdataPath());
        tesseract.setLanguage("chi_sim+eng");
        // tessdata_fast/best 只含 LSTM 数据,显式 OEM=1,避免 AUTO 模式探测 legacy 数据引发兼容问题
        tesseract.setOcrEngineMode(1);
        return tesseract.doOCR(rgb);
    }

    private String tikaExtract(String name, byte[] content) throws Exception {
        Metadata metadata = new Metadata();
        metadata.set(TikaCoreProperties.RESOURCE_NAME_KEY, name);
        StringWriter sink = new StringWriter();
        // BodyContentHandler(Writer) 不限写入长度;默认构造的 100k 上限会截断长文档
        try (InputStream stream = new ByteArrayInputStream(content)) {
            new AutoDetectParser().parse(stream, new BodyContentHandler(sink), metadata, new ParseContext());
        }
        return sink.toString();
    }

    private static String extensionOf(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) {
            return "";
        }
        return name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }
}
