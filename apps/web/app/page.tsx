// 工具导航首页暂缓建设（待多工具上线前统一规划）；当前唯一可用工具是 OCR，
// 根路径直接重定向过去。静态导出构建会把本页输出为带 meta refresh 的跳转 HTML。
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/ocr");
}
