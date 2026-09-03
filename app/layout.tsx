import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./reference-ui.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: "Pulse · 你的个人管理 Agent",
  description: "连接飞书、项目、资料、任务与长期记忆的个人管理 Agent。",
  openGraph: { title: "Pulse · 你的个人管理 Agent", description: "把输入交给 Agent，让重要的事始终在前面。", images:["/og.png"] },
  twitter: { card:"summary_large_image", title:"Pulse · 你的个人管理 Agent", description:"把输入交给 Agent，让重要的事始终在前面。", images:["/og.png"] },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
