import React, { useState } from 'react';
import {
  GestureResponderEvent,
  LayoutChangeEvent,
  StyleSheet,
  Text,
  View,
} from 'react-native';

interface PrecisionSliderProps {
  value: number; // Normalized 0..1 position
  onChange: (normalizedValue: number) => void;
  disabled?: boolean;
  leftLabel?: string;
  rightLabel?: string;
  accentColor?: string;
}

/**
 * Tactile camera dial / slider built on native Responder touch callbacks so we can map
 * either linear parameters (ISO, Focus Diopters, Kelvin) or logarithmic parameters
 * (Shutter Speed) smoothly at 60fps.
 */
export function PrecisionSlider({
  value,
  onChange,
  disabled = false,
  leftLabel,
  rightLabel,
  accentColor = '#F59E0B',
}: PrecisionSliderProps) {
  const [trackWidth, setTrackWidth] = useState<number>(1);

  const handleLayout = (e: LayoutChangeEvent) => {
    const w = Math.max(1, e.nativeEvent.layout.width);
    setTrackWidth(w);
  };

  const updateFromTouch = (evt: GestureResponderEvent) => {
    if (disabled) return;
    const x = evt.nativeEvent.locationX;
    const norm = Math.max(0, Math.min(1, x / Math.max(1, trackWidth)));
    onChange(norm);
  };

  const clamped = Math.max(0, Math.min(1, value));
  const thumbLeft = clamped * Math.max(0, trackWidth - 20);

  return (
    <View style={[styles.wrapper, disabled && styles.wrapperDisabled]}>
      <View
        style={styles.touchArea}
        onLayout={handleLayout}
        onStartShouldSetResponder={() => !disabled}
        onMoveShouldSetResponder={() => !disabled}
        onResponderGrant={updateFromTouch}
        onResponderMove={updateFromTouch}
      >
        {/* Dial tick marks */}
        <View style={styles.ticksRow} pointerEvents="none">
          {Array.from({ length: 21 }).map((_, idx) => (
            <View
              key={idx}
              style={[
                styles.tick,
                idx % 5 === 0 ? styles.tickMajor : styles.tickMinor,
              ]}
            />
          ))}
        </View>

        <View style={styles.trackBg} pointerEvents="none">
          <View
            style={[
              styles.trackFill,
              { width: `${clamped * 100}%`, backgroundColor: accentColor },
            ]}
          />
        </View>

        <View
          pointerEvents="none"
          style={[
            styles.thumb,
            {
              left: thumbLeft,
              borderColor: accentColor,
            },
          ]}
        />
      </View>

      {(leftLabel || rightLabel) && (
        <View style={styles.boundsRow}>
          <Text style={styles.boundText}>{leftLabel}</Text>
          <Text style={styles.boundText}>{rightLabel}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
  },
  wrapperDisabled: {
    opacity: 0.4,
  },
  touchArea: {
    height: 36,
    justifyContent: 'center',
    position: 'relative',
  },
  ticksRow: {
    position: 'absolute',
    left: 6,
    right: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  tick: {
    width: 1,
    backgroundColor: '#334155',
  },
  tickMajor: {
    height: 14,
    backgroundColor: '#64748B',
  },
  tickMinor: {
    height: 7,
  },
  trackBg: {
    height: 4,
    backgroundColor: '#1E293B',
    borderRadius: 2,
    overflow: 'hidden',
  },
  trackFill: {
    height: '100%',
    borderRadius: 2,
  },
  thumb: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#0F172A',
    borderWidth: 2.5,
  },
  boundsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  boundText: {
    color: '#64748B',
    fontSize: 10,
    fontWeight: '700',
  },
});
