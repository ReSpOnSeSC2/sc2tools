"use client";
import { Suspense } from "react";
import { LoadingRows } from "../components/AdminFragments";
import { ClassifierConsole } from "./ClassifierConsole";
export default function ClassifierPage() { return <Suspense fallback={<LoadingRows />}><ClassifierConsole /></Suspense>; }
