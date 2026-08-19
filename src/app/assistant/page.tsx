import { NewConversationComposer } from "@/components/assistant/new-conversation-composer";
import { isAgentConfigured } from "@/lib/agent";

export const dynamic = "force-dynamic";

// The new-conversation surface: a centered composer. Existing threads live
// in the layout's sidebar.
export default async function AssistantPage() {
  // Env presence decides the runner at request time - force-dynamic keeps
  // this honest after an env change.
  const configured = isAgentConfigured();

  return (
    <div className="mx-auto flex min-h-[55vh] w-full max-w-2xl flex-col items-center justify-center gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        What can I help with?
      </h1>
      {configured ? (
        <div className="w-full">
          <NewConversationComposer />
        </div>
      ) : (
        <div className="w-full rounded-md border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-200">
          Assistant unavailable. Set ANTHROPIC_API_KEY to enable it.
        </div>
      )}
    </div>
  );
}
