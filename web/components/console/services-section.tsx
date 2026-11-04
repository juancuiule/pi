"use client";

// Links to the Services the edge serves beside the console (Langfuse, SeaweedFS, SearXNG at /_/<name>/), for an
// account the server lets open them. Nothing shows without them: in `pnpm dev` there is no edge to serve /_/.
import { ExternalLink } from "lucide-react";

import { useServices } from "@/lib/queries";

export const ServicesSection = () => {
  const { data: services } = useServices();
  if (services === undefined || services.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="services-heading" className="flex flex-col gap-2">
      <h2 id="services-heading" className="font-heading text-sm font-semibold">
        Services
      </h2>
      <p className="text-muted-foreground text-xs">
        They show every account&apos;s data, so only some accounts see them.
      </p>
      <ul className="flex flex-col gap-1">
        {services.map((service) => (
          <li key={service.name}>
            <a
              href={service.path}
              target="_blank"
              rel="noopener"
              className="hover:bg-muted focus-visible:ring-ring flex items-start gap-2 rounded-md px-2 py-1.5 outline-none focus-visible:ring-2"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{service.label}</span>
                <span className="text-muted-foreground text-xs">
                  {service.description}
                </span>
              </span>
              <ExternalLink
                aria-hidden
                className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
              />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
};
