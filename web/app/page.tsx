"use client";

import { useQuery } from "@tanstack/react-query";

import { runApi } from "@/lib/api";

const Home = () => {
  const { data, error } = useQuery({
    queryKey: ["info"],
    queryFn: () => runApi((c) => c.info.get()),
  });
  return (
    <main className="p-6 text-sm">
      {error ? `error: ${error.message}` : null}
      {data ? `model: ${data.model}` : null}
    </main>
  );
};

export default Home;
