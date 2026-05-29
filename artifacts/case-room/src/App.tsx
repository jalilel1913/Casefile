import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import CaseList from "@/pages/case-list";
import CaseRoom from "@/pages/case-room";
import { useEffect } from "react";
import { useAuth } from "@workspace/replit-auth-web";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={CaseList} />
      <Route path="/cases/:id" component={CaseRoom} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated, login } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-black text-[#00ff88] font-mono text-sm">
        INITIALIZING...
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-black text-[#00ff88] font-mono gap-6">
        <div className="text-xl tracking-widest">$ casefile</div>
        <p className="text-[#4ade80] text-sm">Authentication required</p>
        <button
          onClick={login}
          className="px-6 py-2 border border-[#00ff88] text-[#00ff88] hover:bg-[#00ff88] hover:text-black transition-colors text-sm tracking-wider"
        >
          LOG IN
        </button>
      </div>
    );
  }

  return <>{children}</>;
}

function App() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthGate>
            <Router />
          </AuthGate>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
