// The application root: instantiates the feature hooks and wires them to the
// components. Almost no logic lives here — find it in:
//
//   api/client.js   every backend call
//   hooks/          state + behavior (conversations, chat streaming, settings,
//                   models, attachments, auto-scroll, FLIP animations)
//   components/     the UI, one file per area
//   lib/            pure helpers (markdown, thinking tags, formatting)

import React, { useState, useEffect } from 'react';

import * as api from './api/client';
import { useSettings } from './hooks/useSettings';
import { useModels } from './hooks/useModels';
import { useAttachments } from './hooks/useAttachments';
import { useAutoScroll } from './hooks/useAutoScroll';
import { useMessageFlip } from './hooks/useMessageFlip';
import { useConversations } from './hooks/useConversations';
import { useChat } from './hooks/useChat';
import { useBrainActivity } from './hooks/useBrainActivity';

import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import MessageList from './components/MessageList';
import Composer from './components/Composer';
import SettingsModal from './components/SettingsModal';
import AddModelModal from './components/AddModelModal';
import ModelLoadingOverlay from './components/ModelLoadingOverlay';
import BrainExplorer from './components/BrainExplorer';
import BrainNameSetup from './components/BrainNameSetup';

const BRAIN_MODE = 'active';

export default function App() {
  const settings = useSettings();
  const models = useModels();
  const attachments = useAttachments();
  const scroll = useAutoScroll();
  const conversations = useConversations({
    getDefaults: () => ({ model: models.modelName, systemPrompt: settings.systemPrompt }),
    onOpened: () => {
      attachments.clearAttachments();
      scroll.lockToBottom();
    },
    onCleared: attachments.clearAttachments,
  });
  const chat = useChat({ conversations, settings, attachments, scroll });
  const registerMessageRef = useMessageFlip(conversations.history);
  const brainActivity = useBrainActivity(settings.brainEnabled);

  // Keep the view following the newest content while the scroll lock is on.
  useEffect(() => {
    scroll.notifyContentChanged();
  }, [conversations.history]);

  // Which floating surfaces are open.
  const [showSettings, setShowSettings] = useState(false);
  const [showAddModel, setShowAddModel] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showBrainExplorer, setShowBrainExplorer] = useState(false);
  // null = unknown/loading, true/false = whether the root node is set up.
  const [brainInitialized, setBrainInitialized] = useState(null);
  const [userName, setUserName] = useState('');

  const [profiles, setProfiles] = useState(() => {
    try {
      const stored = localStorage.getItem('profiles_list');
      if (!stored) return [{ id: 'default', name: 'Default', customNamed: false }];
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return [{ id: 'default', name: 'Default', customNamed: false }];
      return parsed.map(p => {
        if (typeof p === 'string') {
          return { id: p, name: p === 'default' ? 'Default' : p, customNamed: p !== 'default' };
        }
        if (p && typeof p === 'object' && p.id) {
          return {
            id: p.id,
            name: p.name || p.id,
            customNamed: p.customNamed !== undefined ? p.customNamed : (p.id !== 'default')
          };
        }
        return null;
      }).filter(Boolean);
    } catch {
      return [{ id: 'default', name: 'Default', customNamed: false }];
    }
  });

  const [activeProfile, setActiveProfile] = useState(() => {
    return localStorage.getItem('active_profile') || 'default';
  });

  const activeProfileObj = profiles.find(p => p.id === activeProfile) || { id: activeProfile, name: activeProfile };

  const switchProfile = (profileId) => {
    localStorage.setItem('active_profile', profileId);
    window.location.reload();
  };

  const handleCreateProfile = () => {
    const nextNum = profiles.length + 1;
    const cleanId = `profile_${nextNum}_${Date.now()}`;
    const displayName = `New Profile ${nextNum}`;
    
    const newProfile = { id: cleanId, name: displayName, customNamed: false };
    const nextProfiles = [...profiles, newProfile];
    setProfiles(nextProfiles);
    localStorage.setItem('profiles_list', JSON.stringify(nextProfiles));
    switchProfile(cleanId);
  };

  const handleDeleteProfile = async (profile) => {
    if (profile.id === activeProfile) {
      alert("Cannot delete the active profile.");
      return;
    }
    const confirm = window.confirm(`Are you sure you want to delete profile "${profile.name}"? This will permanently delete all of its conversations, files, and memory.`);
    if (!confirm) return;
    
    try {
      await api.deleteProfile(profile.id);
    } catch (err) {
      console.error("Failed to delete profile folder on backend:", err);
    }
    
    const nextProfiles = profiles.filter(p => p.id !== profile.id);
    setProfiles(nextProfiles);
    localStorage.setItem('profiles_list', JSON.stringify(nextProfiles));
  };

  // Check setup state at boot (and when the brain is toggled on). If there's no
  // brain yet, a full-screen name prompt appears before anything else.
  useEffect(() => {
    if (!settings.brainEnabled) { setBrainInitialized(null); return; }
    let cancelled = false;
    let retryTimer = null;

    const checkStatus = () => {
      api.fetchBrainStatus(BRAIN_MODE)
        .then((s) => {
          if (cancelled) return;
          if (s.initialized) {
            setBrainInitialized(true);
            setUserName(s.user_name || '');
          } else {
            // Auto-initialize if it is a custom profile with a valid name and already named by the user
            if (activeProfileObj && activeProfileObj.name && activeProfileObj.name !== 'Default' && activeProfileObj.id !== 'default' && activeProfileObj.customNamed) {
              console.log(`Auto-initializing brain for profile: ${activeProfileObj.name}`);
              api.initBrain(BRAIN_MODE, activeProfileObj.name)
                .then(() => {
                  if (!cancelled) {
                    setBrainInitialized(true);
                    setUserName(activeProfileObj.name);
                  }
                })
                .catch((err) => {
                  console.error('Failed to auto-initialize brain:', err);
                  if (!cancelled) setBrainInitialized(false);
                });
            } else {
              setBrainInitialized(false);
            }
          }
        })
        .catch((err) => {
          console.error('Failed to fetch brain status, retrying...', err);
          if (!cancelled) {
            retryTimer = setTimeout(checkStatus, 3000);
          }
        });
    };

    checkStatus();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [settings.brainEnabled, activeProfileObj]);

  const handleSelectModel = async (model) => {
    setShowModelPicker(false);
    const ok = await models.selectModel(model, settings.systemPrompt);
    if (ok) chat.setIsResponding(false);
  };

  const handleReloadModel = async () => {
    setShowSettings(false);
    const ok = await models.reloadModel(settings.systemPrompt);
    if (ok) chat.setIsResponding(false);
  };

  const handleToggleModelPicker = () => {
    const nextOpen = !showModelPicker;
    setShowModelPicker(nextOpen);
    if (nextOpen) models.refreshModels();
  };

  // Returns true when a download started; the picker reopens to show progress.
  const handleDownloadRequest = (rawRepo) => {
    const started = models.startDownload(rawRepo);
    if (started) {
      setShowAddModel(false);
      setShowModelPicker(true);
    }
    return started;
  };

  // Scroll to bottom when returning to chat from the brain view.
  useEffect(() => {
    if (!showBrainExplorer) {
      scroll.lockToBottom();
      scroll.notifyContentChanged();
    }
  }, [showBrainExplorer]);

  return (
    <div className="app-shell">
      <svg style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }} aria-hidden="true">
        <defs>
          <filter id="make-white-transparent">
            <feColorMatrix type="matrix" values="
              0 0 0 0 0
              0 0 0 0 0
              0 0 0 0 0
             -1 0 0 1 0
            " />
          </filter>
        </defs>
      </svg>
      <TopBar
        sidebarCollapsed={settings.sidebarCollapsed}
        onToggleSidebar={() => settings.setSidebarCollapsed((v) => !v)}
        onNewChat={() => { conversations.newChat(); setShowBrainExplorer(false); }}
        onOpenSettings={() => setShowSettings(true)}
        onToggleBrainExplorer={settings.brainEnabled ? (() => setShowBrainExplorer((v) => !v)) : null}
        showBrainExplorer={showBrainExplorer && settings.brainEnabled}
        brainProcessing={brainActivity.processing}
        modelPickerProps={{
          open: showModelPicker,
          onToggle: handleToggleModelPicker,
          onClose: () => setShowModelPicker(false),
          modelName: models.modelName,
          availableModels: models.availableModels,
          downloads: models.downloads,
          isChangingModel: models.isChangingModel,
          onSelectModel: handleSelectModel,
          onDismissDownload: models.dismissDownload,
          onAddModel: () => {
            setShowModelPicker(false);
            setShowAddModel(true);
          },
        }}
      />
      <div className="app-body">
        <Sidebar
          conversations={conversations.conversations}
          activeId={conversations.activeId}
          collapsed={settings.sidebarCollapsed}
          onSelect={(id) => { conversations.select(id); setShowBrainExplorer(false); }}
          onRename={conversations.rename}
          onDelete={conversations.remove}
          profiles={profiles}
          activeProfile={activeProfile}
          onSwitchProfile={switchProfile}
          onCreateProfile={handleCreateProfile}
          onDeleteProfile={handleDeleteProfile}
        />
        <div className="app-container">
          {showBrainExplorer ? (
            <BrainExplorer
              brainMode={BRAIN_MODE}
              activity={brainActivity}
              detailedLogs={settings.detailedLogs}
              onClose={() => setShowBrainExplorer(false)}
              onReset={() => { setBrainInitialized(false); setShowBrainExplorer(false); }}
            />
          ) : (
            <>
              <MessageList
                history={conversations.history}
                isResponding={chat.isResponding}
                outOfContext={conversations.outOfContext}
                animateFromIndex={conversations.animateFromIndex}
                registerMessageRef={registerMessageRef}
                scroll={scroll}
                onThinkingOpened={scroll.releaseLock}
                userName={userName || (activeProfileObj.name !== 'Default' ? activeProfileObj.name : '')}
              />
              <Composer
                inputText={chat.inputText}
                onInputChange={chat.setInputText}
                onSubmit={chat.send}
                onStop={chat.stop}
                isResponding={chat.isResponding}
                supportsThinking={models.supportsThinking}
                thinkingEnabled={settings.thinkingEnabled}
                onToggleThinking={() => settings.setThinkingEnabled((v) => !v)}
                attachments={attachments}
              />
            </>
          )}
          <SettingsModal
            open={showSettings}
            onClose={() => setShowSettings(false)}
            settings={settings}
            onReloadModel={handleReloadModel}
            onReset={() => {
              setBrainInitialized(false);
              setShowSettings(false);
            }}
          />
          {models.isChangingModel && <ModelLoadingOverlay />}
          <AddModelModal
            open={showAddModel}
            onClose={() => setShowAddModel(false)}
            onDownload={handleDownloadRequest}
          />
        </div>
      </div>

      {settings.brainEnabled && brainInitialized === false && (
        <BrainNameSetup
          brainMode={BRAIN_MODE}
          onDone={(name) => {
            const updated = profiles.map(p => p.id === activeProfile ? { ...p, name, customNamed: true } : p);
            setProfiles(updated);
            localStorage.setItem('profiles_list', JSON.stringify(updated));
            setBrainInitialized(true);
            setUserName(name);
          }}
        />
      )}
    </div>
  );
}
