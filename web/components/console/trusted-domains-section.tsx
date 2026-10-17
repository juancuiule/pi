"use client";

// The domains an artifact page may load images from. A page's CSP only ever fetches images off-origin, and only
// from these hosts; everything else (scripts, styles, fonts, network calls) stays blocked.
import { Plus, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { apiError } from "@/lib/api";
import {
  useAddDomain,
  useRemoveDomain,
  useTrustedDomains,
} from "@/lib/queries";

export const TrustedDomainsSection = () => {
  const { data: domains } = useTrustedDomains();
  const add = useAddDomain();
  const remove = useRemoveDomain();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  return (
    <section
      aria-labelledby="trusted-domains-heading"
      className="flex flex-col gap-2"
    >
      <h2
        id="trusted-domains-heading"
        className="font-heading text-sm font-semibold"
      >
        Trusted domains
      </h2>
      <p className="text-muted-foreground text-xs">
        Artifact pages may load images over http or https from these hosts —
        <span className="font-mono">cdn.example.com</span> is one host,{" "}
        <span className="font-mono">*.example.com</span> also covers its
        subdomains. Everything else a page fetches stays blocked.
      </p>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const domain = value.trim();
          if (domain === "") {
            return;
          }
          setError(undefined);
          add.mutate(domain, {
            onSuccess: () => setValue(""),
            onError: (mutationError) => setError(apiError(mutationError)),
          });
        }}
      >
        <input
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="cdn.example.com or *.example.com"
          aria-label="Domain to trust"
          className="border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-7 min-w-0 flex-1 rounded-md border px-2 font-mono text-xs outline-none focus-visible:ring-3"
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={add.isPending || value.trim() === ""}
        >
          <Plus aria-hidden className="size-3.5" />
          Add
        </Button>
      </form>
      {error === undefined ? null : (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
      {domains?.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No trusted domains — artifact images load only from this server and
          data:/blob: URLs.
        </p>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {domains?.map((domain) => (
          <li key={domain} className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
              {domain}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Stop trusting ${domain}`}
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(domain, {
                  onError: (mutationError) => setError(apiError(mutationError)),
                })
              }
            >
              <X aria-hidden className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
};
