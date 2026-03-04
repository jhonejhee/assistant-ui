"use client";

import Image from "next/image";
import { Assistant } from "./assistant";
import { FullPageChat } from "flowise-embed-react";

export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-500 font-sans dark:bg-black">
        <Assistant />
        {/* <FullPageChat
            chatflowid="28d6433e-ad27-45a4-b9d5-c23b7104d108"
            apiHost="http://94.130.186.85:3000"
        /> */}
    </div>
  );
}
