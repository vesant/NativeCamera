import React from 'react';
import { Tabs } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

// Root navigator for our five core photography & cinematography pillars:
// 1. Sensor Info (Deep Hardware & Camera2 Characteristics Inspector)
// 2. Pro Mode (Manual Exposure, ISO, Diopter Focus, Kelvin WB, Live Histogram & RAW DNG)
// 3. Record (Cinema Video Recorder with 180-degree shutter lock, Rack Focus A/B, 4K/60fps/80Mbps)
// 4. Lab Modes (C++17 HDR+ Exposure Fusion, Light Trails, Night Super-Res & Macro Focus Stack)
// 5. Astro Mode (Multi-frame Star Alignment, Sigma-Clipped Stacking & Tripod Gyro Guard)
export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
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
            fontSize: 10,
            fontWeight: '700',
            letterSpacing: 0.3,
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Sensors',
            tabBarIcon: ({ color, size }) => (
              <MaterialCommunityIcons name="chip" size={size - 2} color={String(color)} />
            ),
          }}
        />
        <Tabs.Screen
          name="pro"
          options={{
            title: 'Pro RAW',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="aperture-outline" size={size - 2} color={String(color)} />
            ),
          }}
        />
        <Tabs.Screen
          name="video"
          options={{
            title: 'Record',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="videocam-outline" size={size - 2} color={String(color)} />
            ),
          }}
        />
        <Tabs.Screen
          name="modes"
          options={{
            title: 'Lab Modes',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="layers-outline" size={size - 2} color={String(color)} />
            ),
          }}
        />
        <Tabs.Screen
          name="astro"
          options={{
            title: 'Astro',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="sparkles-outline" size={size - 2} color={String(color)} />
            ),
          }}
        />
      </Tabs>
    </>
  );
}
