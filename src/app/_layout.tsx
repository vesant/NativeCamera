import React from 'react';
import { Tabs } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

// Root navigator for our three core photography pillars:
// 1. Sensor Info (Deep Hardware & Camera2 Characteristics Inspector)
// 2. Pro Mode (Manual Exposure, ISO, Diopter Focus, Kelvin WB, Live Histogram & RAW DNG)
// 3. Astro Mode (Multi-frame Star Alignment, Sigma-Clipped Stacking & Tripod Gyro Guard)
export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" backgroundColor="#07090D" />
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: {
            backgroundColor: '#0A0D12',
            borderTopColor: '#1B2230',
            borderTopWidth: 1,
            height: 64,
            paddingBottom: 8,
            paddingTop: 6,
          },
          tabBarActiveTintColor: '#F59E0B',
          tabBarInactiveTintColor: '#64748B',
          tabBarLabelStyle: {
            fontSize: 11,
            fontWeight: '700',
            letterSpacing: 0.4,
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Sensor Info',
            tabBarIcon: ({ color, size }) => (
              <MaterialCommunityIcons name="chip" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="pro"
          options={{
            title: 'Pro Mode',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="aperture-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="astro"
          options={{
            title: 'Astro Mode',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="sparkles-outline" size={size} color={color} />
            ),
          }}
        />
      </Tabs>
    </>
  );
}
