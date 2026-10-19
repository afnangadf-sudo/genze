/**
 * Minimal ambient declarations for Expo / React Native modules.
 *
 * The real packages are declared in package.json and get installed by
 * `pnpm install` before any EAS build. These shims exist ONLY so
 * `pnpm typecheck` (tsc --noEmit) can run on a machine without the native
 * Expo toolchain installed. They describe just the API surface this app
 * actually uses. The full `expo install` / `npx expo install --fix` at
 * real setup time remains required before running or building.
 */

declare const process: {
  env: Record<string, string | undefined>;
};

declare module "expo-secure-store" {
  export function getItemAsync(key: string): Promise<string | null>;
  export function setItemAsync(key: string, value: string): Promise<void>;
  export function deleteItemAsync(key: string): Promise<void>;
}

declare module "expo-apple-authentication" {
  export enum AppleAuthenticationScope {
    FULL_NAME = 0,
    EMAIL = 1,
  }
  export interface AppleAuthenticationCredential {
    identityToken: string | null;
    authorizationCode: string | null;
    user: string;
    email: string | null;
    fullName: {
      givenName: string | null;
      familyName: string | null;
    } | null;
  }
  export function isAvailableAsync(): Promise<boolean>;
  export function signInAsync(options: {
    requestedScopes?: AppleAuthenticationScope[];
  }): Promise<AppleAuthenticationCredential>;
}

declare module "expo-av" {
  export namespace Audio {
    export enum InterruptionModeIOS {
      DoNotMix = 1,
    }
    export enum InterruptionModeAndroid {
      DoNotMix = 1,
    }
    export interface RecordingOptions {
      android: Record<string, unknown>;
      ios: Record<string, unknown>;
      web?: Record<string, unknown>;
    }
    export const RecordingOptionsPresets: {
      HIGH_QUALITY: RecordingOptions;
    };
    export interface RecordingStatus {
      isRecording: boolean;
      durationMillis: number;
    }
    export class Recording {
      constructor(options?: { android?: unknown; ios?: unknown });
      prepareToRecordAsync(options?: RecordingOptions): Promise<void>;
      startAsync(): Promise<void>;
      stopAndUnloadAsync(): Promise<void>;
      getURI(): string | null;
      setOnRecordingStatusUpdate(
        cb: ((status: RecordingStatus) => void) | null,
      ): void;
    }
    export function requestPermissionsAsync(): Promise<{ granted: boolean }>;
    export function getPermissionsAsync(): Promise<{ granted: boolean }>;
    export function setAudioModeAsync(mode: {
      allowsRecordingIOS?: boolean;
      playsInSilentModeIOS?: boolean;
      interruptionModeIOS?: InterruptionModeIOS;
      interruptionModeAndroid?: InterruptionModeAndroid;
      shouldDuckAndroid?: boolean;
      playThroughEarpieceAndroid?: boolean;
    }): Promise<void>;
  }
}

declare module "expo-speech" {
  export interface SpeechOptions {
    language?: string;
    pitch?: number;
    rate?: number;
    voice?: string;
    onDone?: () => void;
    onStopped?: () => void;
    onError?: (error: { message: string }) => void;
  }
  export function speak(text: string, options?: SpeechOptions): void;
  export function stop(): Promise<void>;
  export function isSpeakingAsync(): Promise<boolean>;
}

declare module "expo-web-browser" {
  export interface WebBrowserResult {
    type: "cancel" | "dismiss" | "opened";
    url?: string;
  }
  export function openBrowserAsync(
    url: string,
    options?: {
      dismissButtonStyle?: "done" | "close" | "cancel";
      showTitle?: boolean;
    },
  ): Promise<WebBrowserResult>;
  export function dismissBrowser(): Promise<void>;
}

declare module "expo-router" {
  import type * as React from "react";
  export const Stack: any;
  export const Tabs: any;
  export const Slot: any;
  export const Link: any;
  export const Redirect: any;
  export const router: {
    replace(path: string): void;
    push(path: string): void;
    back(): void;
    canGoBack(): boolean;
  };
  export function useRouter(): {
    replace(path: string): void;
    push(path: string): void;
    back(): void;
  };
  export function useLocalSearchParams<T extends Record<string, string>>(): T;
  export function useSegments(): string[];
  export function useGlobalSearchParams<T extends Record<string, string>>(): Partial<T>;
  export function usePathname(): string;
}
