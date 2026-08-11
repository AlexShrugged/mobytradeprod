import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { AuthControls } from "@/components/nav/auth-controls";
import { TopNav } from "@/components/nav/top-nav";
import { clerkEnabled } from "@/lib/auth/config";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MobyTrade",
  description:
    "Track customs entries, duties, and refunds down to the line item — with SKU-level landed cost and correct HTS classification.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The provider (and the Clerk widgets in the nav slot) render only when
  // keys are configured — without this condition Clerk v7's keyless mode
  // would auto-provision a throwaway dev instance.
  const body = (
    <ThemeProvider>
      <TopNav authSlot={clerkEnabled ? <AuthControls /> : null} />
      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6">
        {children}
      </main>
      <Toaster richColors />
    </ThemeProvider>
  );
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {clerkEnabled ? <ClerkProvider>{body}</ClerkProvider> : body}
      </body>
    </html>
  );
}
