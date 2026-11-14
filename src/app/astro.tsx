import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export default function AstroModeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>NativeCamera • Computational Astro</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#07090D',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '700',
  },
});
