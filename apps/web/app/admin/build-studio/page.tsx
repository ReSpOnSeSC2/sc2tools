"use client";
import { Suspense } from "react";
import { LoadingRows } from "../components/AdminFragments";
import { BuildStudioBody } from "./BuildStudioPage";
export default function BuildStudioPage() { return <Suspense fallback={<LoadingRows />}><BuildStudioBody /></Suspense>; }
