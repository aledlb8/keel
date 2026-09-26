import { Agents } from "@/components/Agents";
import { Closing } from "@/components/Closing";
import { Features } from "@/components/Features";
import { GridLab } from "@/components/GridLab";
import { Hero } from "@/components/Hero";
import { Keys } from "@/components/Keys";
import { Nav } from "@/components/Nav";

export default function Home() {
  return (
    <>
      <Nav />
      <main className="overflow-x-clip">
        <Hero />
        <Agents />
        <GridLab />
        <Features />
        <Keys />
        <Closing />
      </main>
    </>
  );
}
