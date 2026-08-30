import { useState } from "react";
import { ExportTab } from "./components/ExportTab";
import { Generator } from "./components/Generator";
import { MonsterTab } from "./components/MonsterTab";
import { PetTab } from "./components/PetTab";

type Tab = "character" | "monster" | "pet" | "export";

export function App() {
  const [tab, setTab] = useState<Tab>("character");

  return (
    <div className="app">
      <header className="topbar">
        <h1>Ragnarok Sprite Generator</h1>
        <div className="tabs">
          <button className={tab === "character" ? "on" : ""} onClick={() => setTab("character")}>
            Character
          </button>
          <button className={tab === "monster" ? "on" : ""} onClick={() => setTab("monster")}>
            Monsters
          </button>
          <button className={tab === "pet" ? "on" : ""} onClick={() => setTab("pet")}>
            Pets
          </button>
          <button className={tab === "export" ? "on" : ""} onClick={() => setTab("export")}>
            Batch export
          </button>
        </div>
      </header>

      {tab === "character" && <Generator />}
      {tab === "monster" && <MonsterTab />}
      {tab === "pet" && <PetTab />}
      {tab === "export" && <ExportTab />}
    </div>
  );
}
