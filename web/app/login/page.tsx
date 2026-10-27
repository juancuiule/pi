"use client";

// Sign in, or, while no account exists, create the first one. Outside the (console) group: no sidebar, no gate.
import { NAME_RULE, PASSWORD_RULE } from "effect-pi/api";
import { LoaderCircle } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { apiError, ApiFailureError } from "@/lib/api";
import { useAuthState, useSignIn } from "@/lib/queries";
import { safeNext } from "@/lib/session";
import { formProblem } from "@/lib/sign-in";
import type { FormProblem, SignInForm, SignInMode } from "@/lib/sign-in";

const INPUT =
  "border-input bg-background focus-visible:border-ring focus-visible:ring-ring aria-invalid:border-destructive h-8 w-full min-w-0 rounded-md border px-2.5 text-base outline-none focus-visible:ring-3 md:text-sm";

const Field = ({
  id,
  label,
  hint,
  problem,
  children,
}: {
  id: keyof SignInForm;
  label: string;
  hint?: string;
  problem: FormProblem | undefined;
  children: ReactNode;
}) => (
  <div className="flex flex-col gap-1.5">
    <label htmlFor={id} className="text-sm font-medium">
      {label}
    </label>
    {children}
    {problem?.field === id ? (
      <p id={`${id}-problem`} className="text-destructive text-xs">
        {problem.message}
      </p>
    ) : null}
    {hint === undefined || problem?.field === id ? null : (
      <p id={`${id}-hint`} className="text-muted-foreground text-xs">
        {hint}
      </p>
    )}
  </div>
);

/** The props an input needs to point at its field's problem or hint. */
const describedBy = (
  id: keyof SignInForm,
  problem: FormProblem | undefined,
  hint: boolean
) => {
  if (problem?.field === id) {
    return { "aria-invalid": true, "aria-describedby": `${id}-problem` };
  }
  return { "aria-describedby": hint ? `${id}-hint` : undefined };
};

const SignInCard = ({ mode }: { mode: SignInMode }) => {
  const signIn = useSignIn();
  const { refetch } = useAuthState();
  const [form, setForm] = useState<SignInForm>({
    name: "",
    password: "",
    confirm: "",
  });
  const [problem, setProblem] = useState<FormProblem | undefined>();
  const inputs = useRef<Partial<Record<keyof SignInForm, HTMLInputElement>>>(
    {}
  );
  const setup = mode === "setup";

  const edit = (field: keyof SignInForm, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    if (problem?.field === field) {
      setProblem(undefined);
    }
  };

  const submit = () => {
    const found = formProblem(mode, form);
    setProblem(found);
    if (found !== undefined) {
      inputs.current[found.field]?.focus();
      return;
    }
    signIn.mutate(
      { mode, name: form.name, password: form.password },
      {
        // Success sets the auth state, which sends LoginView on to `next`.
        onError: (error) => {
          const failure =
            error instanceof ApiFailureError ? error.failure : undefined;
          // Someone else created the first account meanwhile: show the sign-in form instead.
          if (
            typeof failure === "object" &&
            failure !== null &&
            "_tag" in failure &&
            failure._tag === "SetupClosed"
          ) {
            void refetch();
          }
        },
      }
    );
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{setup ? "Create the first account" : "Sign in"}</CardTitle>
        <CardDescription>
          {setup
            ? "No account exists yet. This one keeps every conversation made so far; later accounts are added with pnpm user add."
            : "Sign in to use the effect-pi console."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field
            id="name"
            label="Name"
            hint={setup ? `${NAME_RULE}.` : undefined}
            problem={problem}
          >
            <input
              id="name"
              ref={(element) => {
                inputs.current.name = element ?? undefined;
              }}
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- the page is only this form
              autoFocus
              value={form.name}
              onChange={(event) => edit("name", event.target.value)}
              className={INPUT}
              {...describedBy("name", problem, setup)}
            />
          </Field>
          <Field
            id="password"
            label="Password"
            hint={setup ? `${PASSWORD_RULE}.` : undefined}
            problem={problem}
          >
            <input
              id="password"
              ref={(element) => {
                inputs.current.password = element ?? undefined;
              }}
              type="password"
              autoComplete={setup ? "new-password" : "current-password"}
              value={form.password}
              onChange={(event) => edit("password", event.target.value)}
              className={INPUT}
              {...describedBy("password", problem, setup)}
            />
          </Field>
          {setup ? (
            <Field id="confirm" label="Confirm password" problem={problem}>
              <input
                id="confirm"
                ref={(element) => {
                  inputs.current.confirm = element ?? undefined;
                }}
                type="password"
                autoComplete="new-password"
                value={form.confirm}
                onChange={(event) => edit("confirm", event.target.value)}
                className={INPUT}
                {...describedBy("confirm", problem, false)}
              />
            </Field>
          ) : null}
          {signIn.error === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {apiError(signIn.error)}
            </p>
          )}
          <Button type="submit" disabled={signIn.isPending}>
            {signIn.isPending ? (
              <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
            ) : null}
            {setup ? "Create account" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

const LoginView = () => {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const { data, error, refetch } = useAuthState();
  const signedIn = data?.user !== undefined;

  useEffect(() => {
    if (signedIn) {
      router.replace(next);
    }
  }, [signedIn, next, router]);

  let body: ReactNode = null;
  if (data === undefined && error !== null) {
    body = (
      <div className="flex flex-col items-center gap-3">
        <p className="text-muted-foreground text-sm" role="alert">
          Couldn&apos;t reach the server: {apiError(error)}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void refetch();
          }}
        >
          Try again
        </Button>
      </div>
    );
  } else if (data !== undefined && !signedIn) {
    const mode = data.setup ? "setup" : "login";
    // Keyed by mode, so a form switched by SetupClosed starts empty.
    body = <SignInCard key={mode} mode={mode} />;
  }

  return (
    <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto p-4">
      <title>
        {data?.setup === true
          ? "Create account · effect-pi"
          : "Sign in · effect-pi"}
      </title>
      {body}
    </main>
  );
};

const LoginPage = () => (
  // useSearchParams needs a boundary on a static page.
  <Suspense>
    <LoginView />
  </Suspense>
);

export default LoginPage;
