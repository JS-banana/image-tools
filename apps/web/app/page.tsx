// 工具导航首页暂缓建设；根路径进入当前部署中注册顺序最靠前的工具。
import { redirect } from "next/navigation";
import { ENABLED_TOOLS } from "@/lib/site/tools";

export default function Home() {
  redirect(ENABLED_TOOLS[0].href);
}
