"use client";
import dynamic from "next/dynamic";
import { StreamStudioSignedOutCtas } from "./StreamStudioSignedOutCtas";
/** Auth SDK loads after the useful signed-out HTML, inside a small client island. */
const AuthCtas = dynamic(() => import("./StreamStudioAuthCtas"), {
  ssr: false,
  loading: StreamStudioSignedOutCtas,
});
export function StreamStudioCtas() { return <AuthCtas />; }
