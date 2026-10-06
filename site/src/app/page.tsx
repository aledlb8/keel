import { Agents } from "@/components/Agents";
import { Closing } from "@/components/Closing";
import { Features } from "@/components/Features";
import { GridLab } from "@/components/GridLab";
import { Handoff } from "@/components/Handoff";
import { Hero } from "@/components/Hero";
import { Keys } from "@/components/Keys";
import { Nav } from "@/components/Nav";
import { Phone } from "@/components/Phone";

export default function Home() {
  return (
    <>
      <Nav />
      <main className="overflow-x-clip">
        <Hero />
        <Agents />
        <GridLab />
        <Features />
        <Handoff />
        <Phone />
        <Keys />
        <Closing />
      </main>
    </>
  );
}
