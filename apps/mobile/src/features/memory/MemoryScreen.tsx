import type { ReactNode } from "react";
import { Platform } from "react-native";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SettingsScreen } from "../settings/components/SettingsScreen";

export function MemoryScreen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <NativeStackScreenOptions
        options={{ title, ...(Platform.OS === "android" ? { headerShown: false } : {}) }}
      />
      <SettingsScreen title={title}>
        <ScreenScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1"
          contentContainerClassName="gap-4 px-5 pt-4 pb-8"
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}
