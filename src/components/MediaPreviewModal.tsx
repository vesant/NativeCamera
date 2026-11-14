import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  CapturedMediaItem,
  deleteCapturedMedia,
  getRecentMedia,
  NativeVideoPlayerView,
  openMediaExternal,
  subscribeMediaCaptured,
} from '@/native/CameraEngine';

interface CameraRollPreviewButtonProps {
  size?: number;
  disabled?: boolean;
}

/**
 * Standard camera-app bottom-corner media thumbnail well + full-screen photo & video
 * lightbox modal. Automatically stays synchronized across Pro, Record, Lab, and Astro tabs.
 */
export function CameraRollPreviewButton({
  size = 54,
  disabled = false,
}: CameraRollPreviewButtonProps) {
  const [items, setItems] = useState<CapturedMediaItem[]>([]);
  const [modalVisible, setModalVisible] = useState<boolean>(false);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [videoPaused, setVideoPaused] = useState<boolean>(false);

  const refreshMediaList = useCallback(async () => {
    try {
      const list = await getRecentMedia();
      setItems(list);
    } catch {
      // Ignore transient read errors
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    getRecentMedia()
      .then((list) => {
        if (mounted) {
          setItems(list);
        }
      })
      .catch(() => {});

    const sub = subscribeMediaCaptured((newItem) => {
      setItems((prev) => {
        const filtered = prev.filter((it) => it.id !== newItem.id);
        return [newItem, ...filtered];
      });
      setSelectedIndex(0);
    });
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  const latestItem = items[0] ?? null;
  const activeItem = items[selectedIndex] ?? latestItem;

  const handleOpenModal = () => {
    if (disabled) return;
    refreshMediaList();
    setSelectedIndex(0);
    setVideoPaused(false);
    setModalVisible(true);
  };

  const handleDeleteCurrent = () => {
    if (!activeItem) return;
    Alert.alert(
      'Delete Capture?',
      `Remove "${activeItem.title}" from your camera roll?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteCapturedMedia(activeItem.id);
            const updated = items.filter((it) => it.id !== activeItem.id);
            setItems(updated);
            if (updated.length === 0) {
              setModalVisible(false);
            } else if (selectedIndex >= updated.length) {
              setSelectedIndex(Math.max(0, updated.length - 1));
            }
          },
        },
      ]
    );
  };

  const handleOpenExternalGallery = async () => {
    if (!activeItem) return;
    const targetUri = activeItem.mediaStoreUri || activeItem.uri;
    try {
      await openMediaExternal(targetUri, activeItem.isVideo);
    } catch (e: any) {
      Alert.alert(
        'Saved in DCIM/NativeCamera',
        e?.message || 'File is saved in your phone gallery under DCIM/NativeCamera.'
      );
    }
  };

  return (
    <>
      <Pressable
        style={[
          styles.wellButton,
          { width: size, height: size, borderRadius: Math.round(size * 0.24) },
          disabled && styles.wellDisabled,
        ]}
        onPress={handleOpenModal}
        disabled={disabled}
      >
        {latestItem ? (
          <View style={styles.wellInner}>
            <Image
              source={{ uri: latestItem.thumbnailUri || latestItem.uri }}
              style={styles.wellImage}
              resizeMode="cover"
            />
            {latestItem.isVideo ? (
              <View style={styles.wellVideoOverlay}>
                <Ionicons name="play" size={16} color="#FFFFFF" />
              </View>
            ) : null}
            <View style={styles.wellBadgePill}>
              <Text style={styles.wellBadgeText}>{latestItem.modeBadge}</Text>
            </View>
          </View>
        ) : (
          <View style={styles.wellEmpty}>
            <Ionicons name="images-outline" size={22} color="#8E9BAE" />
          </View>
        )}
      </Pressable>

      <Modal
        visible={modalVisible}
        animationType="fade"
        transparent={false}
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalRoot}>
          {/* Top Header */}
          <View style={styles.topHeader}>
            <Pressable
              style={styles.iconCircleBtn}
              onPress={() => setModalVisible(false)}
            >
              <Ionicons name="close" size={22} color="#F8FAFC" />
            </Pressable>

            <View style={styles.headerTitleBlock}>
              {activeItem ? (
                <>
                  <View style={styles.headerBadgeRow}>
                    <View
                      style={[
                        styles.modeTag,
                        activeItem.isVideo && styles.modeTagVideo,
                      ]}
                    >
                      <Text style={styles.modeTagText}>
                        {activeItem.modeBadge}
                      </Text>
                    </View>
                    <Text style={styles.headerTitleText} numberOfLines={1}>
                      {activeItem.title}
                    </Text>
                  </View>
                  <Text style={styles.headerSubText} numberOfLines={1}>
                    {activeItem.subtitle} • {selectedIndex + 1} of {items.length}
                  </Text>
                </>
              ) : (
                <Text style={styles.headerTitleText}>Camera Roll Preview</Text>
              )}
            </View>

            <View style={styles.headerRightActions}>
              {activeItem ? (
                <>
                  <Pressable
                    style={styles.iconCircleBtn}
                    onPress={handleOpenExternalGallery}
                  >
                    <Ionicons name="share-outline" size={20} color="#38BDF8" />
                  </Pressable>
                  <Pressable
                    style={styles.iconCircleBtn}
                    onPress={handleDeleteCurrent}
                  >
                    <Ionicons name="trash-outline" size={20} color="#F87171" />
                  </Pressable>
                </>
              ) : null}
            </View>
          </View>

          {/* Main Media Viewport */}
          <View style={styles.viewportArea}>
            {activeItem ? (
              activeItem.isVideo ? (
                <View style={styles.videoContainer}>
                  <NativeVideoPlayerView
                    style={styles.mainMedia}
                    sourceUri={activeItem.uri}
                    paused={videoPaused}
                  />
                  <Pressable
                    style={styles.videoTouchOverlay}
                    onPress={() => setVideoPaused((prev) => !prev)}
                  >
                    {videoPaused ? (
                      <View style={styles.bigPlayCircle}>
                        <Ionicons name="play" size={34} color="#FFFFFF" />
                      </View>
                    ) : null}
                    <View style={styles.videoStatusPill}>
                      <Ionicons
                        name={videoPaused ? 'pause' : 'volume-high'}
                        size={13}
                        color="#F8FAFC"
                      />
                      <Text style={styles.videoStatusText}>
                        {videoPaused
                          ? 'PAUSED • TAP TO PLAY'
                          : 'PLAYING MP4 • TAP TO PAUSE'}
                      </Text>
                    </View>
                  </Pressable>
                </View>
              ) : (
                <Image
                  source={{ uri: activeItem.uri }}
                  style={styles.mainMedia}
                  resizeMode="contain"
                />
              )
            ) : (
              <View style={styles.emptyRollBox}>
                <Ionicons name="camera-outline" size={48} color="#475569" />
                <Text style={styles.emptyRollTitle}>No Captures Yet</Text>
                <Text style={styles.emptyRollDesc}>
                  Photos, DNG RAWs, Astro stacks, and Cinema MP4 videos you
                  record will appear right here for instant inspection.
                </Text>
              </View>
            )}

            {/* Left / Right Quick Nav Arrows */}
            {items.length > 1 && selectedIndex > 0 ? (
              <Pressable
                style={[styles.navArrow, styles.navArrowLeft]}
                onPress={() => {
                  setVideoPaused(false);
                  setSelectedIndex((idx) => Math.max(0, idx - 1));
                }}
              >
                <Ionicons name="chevron-back" size={24} color="#FFFFFF" />
              </Pressable>
            ) : null}

            {items.length > 1 && selectedIndex < items.length - 1 ? (
              <Pressable
                style={[styles.navArrow, styles.navArrowRight]}
                onPress={() => {
                  setVideoPaused(false);
                  setSelectedIndex((idx) =>
                    Math.min(items.length - 1, idx + 1)
                  );
                }}
              >
                <Ionicons name="chevron-forward" size={24} color="#FFFFFF" />
              </Pressable>
            ) : null}
          </View>

          {/* Bottom Metadata Action Bar + Filmstrip */}
          {items.length > 0 ? (
            <View style={styles.bottomFilmstripSection}>
              <View style={styles.metaActionRow}>
                <View style={styles.savedPathBadge}>
                  <Ionicons
                    name="checkmark-circle"
                    size={14}
                    color="#10B981"
                  />
                  <Text style={styles.savedPathText}>
                    Saved in DCIM/NativeCamera ({activeItem?.width}×
                    {activeItem?.height})
                  </Text>
                </View>
                <Pressable
                  style={styles.openSystemBtn}
                  onPress={handleOpenExternalGallery}
                >
                  <Ionicons name="open-outline" size={14} color="#0F172A" />
                  <Text style={styles.openSystemBtnText}>Open in Gallery</Text>
                </Pressable>
              </View>

              <FlatList
                data={items}
                horizontal
                showsHorizontalScrollIndicator={false}
                keyExtractor={(item) => item.id}
                contentContainerStyle={styles.filmstripList}
                renderItem={({ item, index }) => {
                  const isSelected = index === selectedIndex;
                  return (
                    <Pressable
                      style={[
                        styles.thumbCard,
                        isSelected && styles.thumbCardActive,
                      ]}
                      onPress={() => {
                        setVideoPaused(false);
                        setSelectedIndex(index);
                      }}
                    >
                      <Image
                        source={{ uri: item.thumbnailUri || item.uri }}
                        style={styles.thumbCardImg}
                        resizeMode="cover"
                      />
                      {item.isVideo ? (
                        <View style={styles.thumbVideoIcon}>
                          <Ionicons name="play" size={12} color="#FFFFFF" />
                        </View>
                      ) : null}
                      <View style={styles.thumbModeTag}>
                        <Text style={styles.thumbModeTagText}>
                          {item.modeBadge}
                        </Text>
                      </View>
                    </Pressable>
                  );
                }}
              />
            </View>
          ) : null}
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  wellButton: {
    backgroundColor: '#111824',
    borderWidth: 2,
    borderColor: 'rgba(245, 158, 11, 0.75)',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  wellDisabled: {
    opacity: 0.45,
  },
  wellInner: {
    width: '100%',
    height: '100%',
  },
  wellImage: {
    width: '100%',
    height: '100%',
  },
  wellVideoOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  wellBadgePill: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    backgroundColor: 'rgba(8, 12, 18, 0.85)',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  wellBadgeText: {
    color: '#F59E0B',
    fontSize: 8,
    fontWeight: '800',
  },
  wellEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalRoot: {
    flex: 1,
    backgroundColor: '#05070B',
  },
  topHeader: {
    paddingTop: 48,
    paddingBottom: 12,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#0B1018',
    borderBottomWidth: 1,
    borderBottomColor: '#1C2636',
  },
  iconCircleBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#151E2C',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#263449',
  },
  headerTitleBlock: {
    flex: 1,
    marginHorizontal: 12,
  },
  headerBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  modeTag: {
    backgroundColor: 'rgba(245, 158, 11, 0.2)',
    borderWidth: 1,
    borderColor: '#F59E0B',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 5,
  },
  modeTagVideo: {
    backgroundColor: 'rgba(239, 68, 68, 0.22)',
    borderColor: '#EF4444',
  },
  modeTagText: {
    color: '#F8FAFC',
    fontSize: 10,
    fontWeight: '800',
  },
  headerTitleText: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '800',
    flexShrink: 1,
  },
  headerSubText: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 2,
  },
  headerRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  viewportArea: {
    flex: 1,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mainMedia: {
    width: '100%',
    height: '100%',
  },
  videoContainer: {
    width: '100%',
    height: '100%',
  },
  videoTouchOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigPlayCircle: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: 'rgba(15, 23, 42, 0.78)',
    borderWidth: 2,
    borderColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoStatusPill: {
    position: 'absolute',
    bottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(11, 16, 24, 0.82)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#263449',
  },
  videoStatusText: {
    color: '#E2E8F0',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  navArrow: {
    position: 'absolute',
    top: '45%',
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(15, 23, 42, 0.72)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  navArrowLeft: {
    left: 12,
  },
  navArrowRight: {
    right: 12,
  },
  emptyRollBox: {
    paddingHorizontal: 36,
    alignItems: 'center',
  },
  emptyRollTitle: {
    color: '#E2E8F0',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 12,
  },
  emptyRollDesc: {
    color: '#64748B',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 19,
  },
  bottomFilmstripSection: {
    backgroundColor: '#0B1018',
    borderTopWidth: 1,
    borderTopColor: '#1C2636',
    paddingTop: 10,
    paddingBottom: 26,
  },
  metaActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  savedPathBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  savedPathText: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '600',
  },
  openSystemBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#38BDF8',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  openSystemBtnText: {
    color: '#0F172A',
    fontSize: 11,
    fontWeight: '800',
  },
  filmstripList: {
    paddingHorizontal: 14,
    gap: 8,
  },
  thumbCard: {
    width: 60,
    height: 60,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: '#1E293B',
    backgroundColor: '#111824',
  },
  thumbCardActive: {
    borderColor: '#F59E0B',
  },
  thumbCardImg: {
    width: '100%',
    height: '100%',
  },
  thumbVideoIcon: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(0,0,0,0.28)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbModeTag: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    backgroundColor: 'rgba(7, 10, 15, 0.85)',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  thumbModeTagText: {
    color: '#F8FAFC',
    fontSize: 8,
    fontWeight: '800',
  },
});
