import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export default function ProModeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>NativeCamera • Pro Manual & RAW</Text>
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
