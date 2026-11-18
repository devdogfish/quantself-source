import { NotificationDeviceSync } from "@/components/notifications/device-sync";
import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import { TodoJarvis } from "@/app/todo/todo-jarvis";
import { TodoStoreProvider } from "@/app/todo/todo-live";
import { TaskWorkspaceProvider } from "@/app/todo/task-workspace-queue";
import { Toaster } from "@/components/chakra/toaster";
import { AppShell } from "@/components/app-shell/app-shell";
import { Provider as ChakraProvider } from "@/components/chakra/provider";
import { EmotionRegistry } from "@/components/chakra/emotion-registry";
import { BRAND_BOOT_SCRIPT } from "@/components/chakra/brand";
import { LAYOUT_BOOT_SCRIPT } from "@/components/app-shell/layout";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Quantself",
  description: "Personal systems workspace.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${geistMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: BRAND_BOOT_SCRIPT + LAYOUT_BOOT_SCRIPT }} />
      </head>
      <body>
        <EmotionRegistry>
          <ChakraProvider>
            <NotificationDeviceSync />
            <TodoStoreProvider>
              <TaskWorkspaceProvider>
                <TodoJarvis>
                  <AppShell>{children}</AppShell>
                  <Toaster />
                </TodoJarvis>
              </TaskWorkspaceProvider>
            </TodoStoreProvider>
          </ChakraProvider>
        </EmotionRegistry>
      </body>
    </html>
  );
}
