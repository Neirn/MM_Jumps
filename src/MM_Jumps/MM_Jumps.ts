import { IPlugin, IModLoaderAPI, ModLoaderEvents } from 'modloader64_api/IModLoaderAPI';
import { bus, EventHandler } from 'modloader64_api/EventHandler'
import { Heap } from 'modloader64_api/heap'
import { IOOTCore, OotEvents, LinkState, Age } from 'modloader64_api/OOT/OOTAPI';
import { InjectCore } from 'modloader64_api/CoreInjection';
import { Z64RomTools } from 'Z64Lib/API/Z64RomTools';
import { Z64LibSupportedGames } from 'Z64Lib/API/Z64LibSupportedGames';
import { onViUpdate, Postinit } from 'modloader64_api/PluginLifecycle';
import { readJSONSync, readFileSync, existsSync, writeFileSync } from 'fs-extra';
import { OotOnlineEvents } from './OotoAPI/OotoAPI';
import path from 'path';

class zzdata {
  config_version!: string;
  config_file!: string;
  jump_flip_anim!: string;
  land_flip_anim!: string;
  jump_somersault_anim!: string;
  land_somersault_anim!: string;
}

interface mm_jumps_options {
  config_version: string;
  default_jump_weight: number;
  rolling_jump_weight: number;
  somersault_jump_weight: number;
  sequential_mode?: boolean;
}

const enum LINK_ANIMETION_OFFSETS {
  JUMP_REGULAR = 0x1B4B00,
  JUMP_FLIP = 0xD710,
  LAND_REGULAR = 0x1B72E0,
  JUMP_SOMERSAULT = 0xDDDE,
  LAND_FLIP = 0xA1E80,
  LAND_SOMERSAULT = 0xA254E,
  FALL = 0x19D3E0,
  FALL_FREE = 0x19DEE0,
  LAND_SHORT = 0x1B72E0,
  LAND_SHORT_UNARMED = 0x1B7B40
}

const GAMEPLAY_KEEP_PTR: number = 0x8016A66C;
const HEAP_SIZE: number = 0x37800;

const enum GAMEPLAY_KEEP_OFFSETS {
  ANIM_JUMP = 0x3148,
  ANIM_LAND = 0x3150,
  ANIM_FALL_LAND = 0x3020,
  ANIM_FALL_LAND_UNARMED = 0x3028,
  ANIM_LAND_SHORT = 0x3168,
  ANIM_LAND_SHORT_UNARMED = 0x3170,
  ANIM_SHORT_JUMP = 0x2FD8,
  ANIM_SHORT_JUMP_LANDING = 0x2FE0,
  ANIM_NORMAL_LANDING_WAIT = 0x3040
}

const enum ANIM_LENGTHS {
  JUMP_DEFAULT = 0xD,
  LAND_DEFAULT = 0x10,
  LAND_DEFAULT_FALL = 0x15,
  JUMP_FLIP = 0xD,
  LAND_FLIP = 0xD,
  JUMP_SOMERSAULT = 0xE,
  LAND_SOMERSAULT = 0x10,
  LAND_DEFAULT_SHORT = 0x10,
  LAND_DEFAULT_SHORT_UNARMED = 0x10
}

const enum SLIDER_RANGE {
  MAX = 100,
  MIN = 0
}

function getRandomInt(max: number): number {
  return Math.floor(Math.random() * Math.floor(max));
}

function createAnimTableEntry(offset: number, frameCount: number, segment: number): Buffer {
  let bankOffset1: number = (offset >> 16) & 0xFF;
  let bankOffset2: number = (offset >> 8) & 0xFF;
  let bankOffset3: number = offset & 0xFF;
  let frameCount1: number = frameCount >> 16 & 0xFF;
  let frameCount2: number = frameCount & 0xFF;
  return Buffer.from([frameCount1, frameCount2, 0, 0, segment, bankOffset1, bankOffset2, bankOffset3]);
}

class main implements IPlugin {
  ModLoader!: IModLoaderAPI;
  pluginName?: string | undefined;
  @InjectCore()
  core!: IOOTCore;
  defaultWeight: number[] = [0];
  flipWeight: number[] = [0];
  somersaultWeight: number[] = [0];
  jumpInProgress: boolean = false;
  wasPaused: boolean = false;
  currentJump!: number;
  currentLanding!: number
  loadSuccess: boolean = false;
  jumpNeedsUpdate: boolean = true;
  isSequentialMode: boolean[] = [false];
  currentJumpInSequence: number = 0;
  debugWindowOpen = false;
  myAlloc!: { model: Buffer, age: Age, slot: number, pointer: number };
  jumpsHeap!: Heap;
  jumpFlipDataPtr: number = 0;
  jumpSomersaultDataPtr: number = 0;
  landFlipDataPtr: number = 0;
  landSomersaultDataPtr: number = 0;
  myNamePtr: number = 0;

  applyJumpSwap(animOffset: number) {
    let jumpLen: number;
    let seg: number = 80;

    switch (animOffset) {
      case LINK_ANIMETION_OFFSETS.JUMP_SOMERSAULT:
        jumpLen = ANIM_LENGTHS.JUMP_SOMERSAULT;
        break;

      case LINK_ANIMETION_OFFSETS.JUMP_FLIP:
        jumpLen = ANIM_LENGTHS.JUMP_FLIP;
        break;

      default:
        /* Just play the regular flip animation if the parameter isn't one of the two jumps */
        animOffset = LINK_ANIMETION_OFFSETS.JUMP_REGULAR;
        jumpLen = ANIM_LENGTHS.JUMP_DEFAULT;
        seg = 7;
        break;
    }

    this.ModLoader.emulator.rdramWritePtrBuffer(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_JUMP, createAnimTableEntry(animOffset, jumpLen, seg));
    this.currentJump = animOffset;
  }

  applyLandingSwap(jumpOffset: number) {
    /* Set up parameters for default landing animation */
    let landLen: number = ANIM_LENGTHS.LAND_DEFAULT;
    let fallLen: number = ANIM_LENGTHS.LAND_DEFAULT_FALL;
    let landShortLen: number = ANIM_LENGTHS.LAND_DEFAULT_SHORT;
    let landShortUnarmedLen: number = ANIM_LENGTHS.LAND_DEFAULT_SHORT_UNARMED;
    let landOffset: number = LINK_ANIMETION_OFFSETS.LAND_REGULAR;
    let fallOffset: number = LINK_ANIMETION_OFFSETS.FALL;
    let fallFreeOffset: number = LINK_ANIMETION_OFFSETS.FALL_FREE;
    let landShortOffset: number = LINK_ANIMETION_OFFSETS.LAND_SHORT;
    let landShortUnarmedOffset: number = LINK_ANIMETION_OFFSETS.LAND_SHORT_UNARMED;
    let seg = 7;

    /* Only swap from default during MM jump */
    let isMMJump: boolean = false;
    switch (jumpOffset) {
      case LINK_ANIMETION_OFFSETS.JUMP_SOMERSAULT:
        isMMJump = true;
        landLen = ANIM_LENGTHS.LAND_SOMERSAULT;
        landOffset = LINK_ANIMETION_OFFSETS.LAND_SOMERSAULT;
        break;

      case LINK_ANIMETION_OFFSETS.JUMP_FLIP:
        isMMJump = true;
        landLen = ANIM_LENGTHS.LAND_FLIP;
        landOffset = LINK_ANIMETION_OFFSETS.LAND_FLIP;
        break;

      default:
        break;
    }

    if (isMMJump) {
      fallLen = landLen;
      landShortLen = landLen;
      landShortUnarmedLen = landLen;
      fallOffset = landOffset;
      fallFreeOffset = landOffset;
      landShortOffset = landOffset;
      landShortUnarmedOffset = landOffset;
      seg = 0x80;
    }

    this.ModLoader.emulator.rdramWritePtrBuffer(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_LAND, createAnimTableEntry(landOffset, landLen, seg));
    this.ModLoader.emulator.rdramWritePtrBuffer(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_FALL_LAND, createAnimTableEntry(fallOffset, fallLen, seg));
    this.ModLoader.emulator.rdramWritePtrBuffer(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_FALL_LAND_UNARMED, createAnimTableEntry(fallFreeOffset, fallLen, seg));
    this.ModLoader.emulator.rdramWritePtrBuffer(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_LAND_SHORT, createAnimTableEntry(landShortOffset, landShortLen, seg));
    this.ModLoader.emulator.rdramWritePtrBuffer(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_LAND_SHORT_UNARMED, createAnimTableEntry(landShortUnarmedOffset, landShortUnarmedLen, seg));
    this.currentLanding = landOffset;
  }

  selectJumpRandomly(): number {
    let total: number = this.flipWeight[0] + this.defaultWeight[0] + this.somersaultWeight[0];

    let rng: number = getRandomInt(total);

    if (rng < this.somersaultWeight[0]) {
      return LINK_ANIMETION_OFFSETS.JUMP_SOMERSAULT;
    }
    else if (rng < this.somersaultWeight[0] + this.flipWeight[0]) {
      return LINK_ANIMETION_OFFSETS.JUMP_FLIP;
    }
    else return LINK_ANIMETION_OFFSETS.JUMP_REGULAR;
  }

  createConfig(defaultWeight: number, rollWeight: number, somerWeight: number, seqMode: boolean, configVersion: string, filePath: string): void {
    writeFileSync(filePath, JSON.stringify({ config_version: configVersion, default_jump_weight: defaultWeight, rolling_jump_weight: rollWeight, somersault_jump_weight: somerWeight, sequential_mode: seqMode } as mm_jumps_options, null, 5));
  }

  getCurrentJumpInMemory(): number {
    /* need to get bottom 3 bytes of animation table entry */
    return (this.ModLoader.emulator.rdramReadPtr32(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_JUMP + 5) << 16) | (this.ModLoader.emulator.rdramReadPtr16(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_JUMP + 7));
  }

  getCurrentJumpString(): string {
    return this.ModLoader.emulator.rdramReadPtr32(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_JUMP + 5).toString(16) + this.ModLoader.emulator.rdramReadPtr16(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_JUMP + 7).toString(16);
  }

  isJumpUpToDate(): boolean {
    return this.getCurrentJumpInMemory() === this.currentJump;
  }

  preinit(): void { }

  init(): void {
    let zz: zzdata = (this as any)['metadata']['configData'];

    /* Default chances of each jump */
    let defaultDefault: number = 34;
    let flipDefault: number = 33;
    let somersaultDefault: number = 33;
    let sequentialDefault: boolean = false;

    try {
      let config: mm_jumps_options;

      /* default config file values */
      if (!existsSync(zz.config_file)) {
        this.defaultWeight[0] = defaultDefault;
        this.flipWeight[0] = flipDefault;
        this.somersaultWeight[0] = somersaultDefault;
        this.isSequentialMode[0] = sequentialDefault;
      }
      else {
        config = readJSONSync(zz.config_file);

        if (!config.sequential_mode) {
          config.sequential_mode = false;
        }

        /* Import settings when updating config file */
        if (config.config_version !== zz.config_version) {
          this.ModLoader.logger.info("Config file out of date! Attempting to update...");
          this.createConfig(config.default_jump_weight, config.rolling_jump_weight, config.somersault_jump_weight, config.sequential_mode, zz.config_version, zz.config_file);
        }

        this.defaultWeight[0] = config.default_jump_weight;
        this.flipWeight[0] = config.rolling_jump_weight;
        this.somersaultWeight[0] = config.somersault_jump_weight;
        this.isSequentialMode[0] = config.sequential_mode;
      }
    } catch (error) {
      this.ModLoader.logger.error(error.name + ": " + error.message)
      this.ModLoader.logger.warn("Error reading config file! Loading default values...")
      this.defaultWeight[0] = defaultDefault;
      this.flipWeight[0] = flipDefault;
      this.somersaultWeight[0] = somersaultDefault;
      this.isSequentialMode[0] = sequentialDefault;
      if (existsSync(zz.config_file)) {
        this.createConfig(this.defaultWeight[0], this.flipWeight[0], this.somersaultWeight[0], this.isSequentialMode[0], zz.config_version, zz.config_file);
      }
    }

    /* Offset is vanilla before swapping any animations */
    this.currentJump = LINK_ANIMETION_OFFSETS.JUMP_REGULAR;
    this.currentLanding = LINK_ANIMETION_OFFSETS.LAND_REGULAR;

    /* gimme memory */
    this.myAlloc = { model: Buffer.alloc(1), age: Age.ADULT, slot: 0, pointer: 0 };
    bus.emit(OotOnlineEvents.ALLOCATE_MODEL_BLOCK, this.myAlloc)

  }

  postinit(): void { }

  onTick(): void {
    if (this.loadSuccess) {
      if (this.core.helper.isPaused()) {
        this.wasPaused = true;
        return;
      }

      if (this.core.link.state === LinkState.BUSY || this.core.link.state === LinkState.SWIMMING) {
        this.jumpNeedsUpdate = true;
        return;
      }

      // restore the animation if the game was paused in the middle of a jump
      if (this.wasPaused) {
        this.applyJumpSwap(this.currentJump);
        if (this.jumpInProgress) {
          this.applyLandingSwap(this.currentJump);
        }
        this.wasPaused = false;
      }

      switch (this.core.link.get_anim_id()) {

        case GAMEPLAY_KEEP_OFFSETS.ANIM_JUMP:
          /* Apply the correct landing animation to whatever jump is currently happening, queue jump update upon finishing landing */
          if (!this.jumpInProgress) {
            this.applyLandingSwap(this.currentJump);
            this.jumpInProgress = true;
            this.jumpNeedsUpdate = true;
            if (this.isSequentialMode[0])
              this.currentJumpInSequence = (this.currentJumpInSequence + 1) % 3;
          }
          break;

        /* Don't update the jumping and landing animations while they're playing */
        case GAMEPLAY_KEEP_OFFSETS.ANIM_LAND:
        case GAMEPLAY_KEEP_OFFSETS.ANIM_LAND_SHORT:
        case GAMEPLAY_KEEP_OFFSETS.ANIM_LAND_SHORT_UNARMED:
        case GAMEPLAY_KEEP_OFFSETS.ANIM_FALL_LAND:
        case GAMEPLAY_KEEP_OFFSETS.ANIM_FALL_LAND_UNARMED:
        case GAMEPLAY_KEEP_OFFSETS.ANIM_NORMAL_LANDING_WAIT:
          break;

        default:

          /* Choose next jump */
          if (this.jumpNeedsUpdate) {
            if (this.isSequentialMode[0]) {
              switch (this.currentJumpInSequence) {
                case 0:
                  this.currentJump = LINK_ANIMETION_OFFSETS.JUMP_REGULAR;
                  break;

                case 1:
                  this.currentJump = LINK_ANIMETION_OFFSETS.JUMP_FLIP;
                  break;

                case 2:
                  this.currentJump = LINK_ANIMETION_OFFSETS.JUMP_SOMERSAULT;
                  break;

                default:
                  break;
              }

              this.applyJumpSwap(this.currentJump);

            } else {
              this.applyJumpSwap(this.selectJumpRandomly());
            }
            this.jumpNeedsUpdate = false;
          }

          if (this.currentLanding !== LINK_ANIMETION_OFFSETS.LAND_REGULAR) {
            /* fix landing for backflips, ledge drops, etc when MM Jump not in progress */
            this.applyLandingSwap(LINK_ANIMETION_OFFSETS.JUMP_REGULAR);
          }

          this.jumpInProgress = false;

          break;
      }
    }
  }

  @EventHandler(ModLoaderEvents.ON_ROM_PATCHED_POST)
  onRomPatchedPost(evt: any): void {
    let linkAnimdma: number = 0x7;

    this.ModLoader.logger.info("Loading Majora's Mask Jump animations...");

    try {
      let zz: zzdata = (this as any)['metadata']['configData'];
      try {
        // let tools: Z64RomTools = new Z64RomTools(this.ModLoader, Z64LibSupportedGames.OCARINA_OF_TIME);
        try {
          // let animationData: Buffer = tools.decompressDMAFileFromRom(evt.rom, linkAnimdma);
          return;
          try {
            let jumpFlipBuff: Buffer = readFileSync(path.resolve(path.join(__dirname, zz.jump_flip_anim)));
            let landFlipBuff: Buffer = readFileSync(path.resolve(path.join(__dirname, zz.land_flip_anim)));
            let jumpSomerBuff: Buffer = readFileSync(path.resolve(path.join(__dirname, zz.jump_somersault_anim)));
            let landSomerBuff: Buffer = readFileSync(path.resolve(path.join(__dirname, zz.land_somersault_anim)));

            try {
              this.jumpsHeap = new Heap(this.ModLoader.emulator, this.myAlloc.pointer, HEAP_SIZE);

              this.jumpFlipDataPtr = this.jumpsHeap.malloc(jumpFlipBuff.length);
              this.jumpSomersaultDataPtr = this.jumpsHeap.malloc(jumpSomerBuff.length);
              this.landFlipDataPtr = this.jumpsHeap.malloc(landFlipBuff.length);
              this.landSomersaultDataPtr = this.jumpsHeap.malloc(landSomerBuff.length);

              try {
                this.ModLoader.emulator.rdramWriteBuffer(this.jumpFlipDataPtr, jumpFlipBuff);
                this.ModLoader.emulator.rdramWriteBuffer(this.jumpSomersaultDataPtr, jumpSomerBuff);
                this.ModLoader.emulator.rdramWriteBuffer(this.landFlipDataPtr, landFlipBuff);
                this.ModLoader.emulator.rdramWriteBuffer(this.landSomersaultDataPtr, landSomerBuff);
              } catch (error) {
                this.ModLoader.logger.error("Error copying jump animations to heap!");
                throw new Error(error.message);
              }
            } catch (error) {
              this.ModLoader.logger.error("Error creating heap!");
              this.ModLoader.logger.error(error.message);
              throw new Error(error.message);
            }
            /*
            try {
              jumpFlipBuff.copy(animationData, LINK_ANIMETION_OFFSETS.JUMP_FLIP);
              landFlipBuff.copy(animationData, LINK_ANIMETION_OFFSETS.LAND_FLIP);
              jumpSomerBuff.copy(animationData, LINK_ANIMETION_OFFSETS.JUMP_SOMERSAULT);
              landSomerBuff.copy(animationData, LINK_ANIMETION_OFFSETS.LAND_SOMERSAULT);
              try {
                tools.recompressDMAFileIntoRom(evt.rom, linkAnimdma, animationData);
                this.ModLoader.logger.info("Majora's Mask jump animations loaded!");
                this.loadSuccess = true;
              } catch (error) {
                this.ModLoader.logger.error("Error re-injecting the animations to the ROM!");
                this.ModLoader.logger.error(error.message);
              }
            } catch (error) {
              this.ModLoader.logger.error("Error copying MM jumps to animation buffer!");
              this.ModLoader.logger.error(error.message);
            } */
          } catch (error) {
            this.ModLoader.logger.error("Error reading Majora's Mask jump animation files!");
            this.ModLoader.logger.error(error.message);
          }
        } catch (error) {
          this.ModLoader.logger.error("Error extracting Link's animations from the ROM!")
          this.ModLoader.logger.error(error.message);
        }
      } catch (error) {
        this.ModLoader.logger.error("Z64Lib error! Is Z64Lib outdated?");
        this.ModLoader.logger.error(error.message);
      }

    } catch (error) {
      this.ModLoader.logger.error("Error loading metadata from package.json!");
      this.ModLoader.logger.error(error.message);
    }
  }

  @Postinit()
  setupJumpsHeap() {
    let zz: zzdata = (this as any)['metadata']['configData'];
    try {
      let jumpFlipBuff: Buffer = readFileSync(path.resolve(path.join(__dirname, zz.jump_flip_anim)));
      let landFlipBuff: Buffer = readFileSync(path.resolve(path.join(__dirname, zz.land_flip_anim)));
      let jumpSomerBuff: Buffer = readFileSync(path.resolve(path.join(__dirname, zz.jump_somersault_anim)));
      let landSomerBuff: Buffer = readFileSync(path.resolve(path.join(__dirname, zz.land_somersault_anim)));

      try {
        this.jumpsHeap = new Heap(this.ModLoader.emulator, this.myAlloc.pointer, HEAP_SIZE);

        let myName: Buffer = Buffer.from("MM_JUMPS_HEAP_V1", "ascii");

        this.myNamePtr = this.jumpsHeap.malloc(myName.length);
        this.jumpFlipDataPtr = this.jumpsHeap.malloc(jumpFlipBuff.length);
        this.jumpSomersaultDataPtr = this.jumpsHeap.malloc(jumpSomerBuff.length);
        this.landFlipDataPtr = this.jumpsHeap.malloc(landFlipBuff.length);
        this.landSomersaultDataPtr = this.jumpsHeap.malloc(landSomerBuff.length);

        try {
          this.ModLoader.emulator.rdramWriteBuffer(this.myNamePtr, myName);
          this.ModLoader.emulator.rdramWriteBuffer(this.jumpFlipDataPtr, jumpFlipBuff);
          this.ModLoader.emulator.rdramWriteBuffer(this.jumpSomersaultDataPtr, jumpSomerBuff);
          this.ModLoader.emulator.rdramWriteBuffer(this.landFlipDataPtr, landFlipBuff);
          this.ModLoader.emulator.rdramWriteBuffer(this.landSomersaultDataPtr, landSomerBuff);
        } catch (error) {
          this.ModLoader.logger.error("Error copying jump animations to heap!");
          throw new Error(error.message);
        }
      } catch (error) {
        this.ModLoader.logger.error("Error creating heap!");
        this.ModLoader.logger.error(error.message);
        throw new Error(error.message);
      }
      /*
      try {
        jumpFlipBuff.copy(animationData, LINK_ANIMETION_OFFSETS.JUMP_FLIP);
        landFlipBuff.copy(animationData, LINK_ANIMETION_OFFSETS.LAND_FLIP);
        jumpSomerBuff.copy(animationData, LINK_ANIMETION_OFFSETS.JUMP_SOMERSAULT);
        landSomerBuff.copy(animationData, LINK_ANIMETION_OFFSETS.LAND_SOMERSAULT);
        try {
          tools.recompressDMAFileIntoRom(evt.rom, linkAnimdma, animationData);
          this.ModLoader.logger.info("Majora's Mask jump animations loaded!");
          this.loadSuccess = true;
        } catch (error) {
          this.ModLoader.logger.error("Error re-injecting the animations to the ROM!");
          this.ModLoader.logger.error(error.message);
        }
      } catch (error) {
        this.ModLoader.logger.error("Error copying MM jumps to animation buffer!");
        this.ModLoader.logger.error(error.message);
      } */
    } catch (error) {
      this.ModLoader.logger.error("Error reading Majora's Mask jump animation files!");
      this.ModLoader.logger.error(error.message);
    }
  }

  /* Upon reloading gameplay_keep, the jump resets to default, so queue up a new one */
  @EventHandler(OotEvents.ON_SCENE_CHANGE)
  onSceneChange() {
    this.jumpNeedsUpdate = true;
    this.currentJump = LINK_ANIMETION_OFFSETS.JUMP_REGULAR;
  }

  /* menu bar stuff */
  @onViUpdate()
  onViUpdate() {
    if (this.ModLoader.ImGui.beginMainMenuBar()) {
      if (this.ModLoader.ImGui.beginMenu("Mods")) {
        if (this.ModLoader.ImGui.beginMenu("MM Jumps")) {
          this.addSlider("Default Frequency", "##mmjumps_default_slider", this.defaultWeight);
          this.addSlider("Front Flip Frequency", "##mmjumps_front_flip_slider", this.flipWeight);
          this.addSlider("Somersault Frequency", "##mmjumps_somersault_slider", this.somersaultWeight);
          if (this.ModLoader.ImGui.checkbox("Sequential Mode", this.isSequentialMode)) {
            this.currentJumpInSequence = 0;
            this.jumpNeedsUpdate = true;
          }
          if (this.ModLoader.ImGui.menuItem("Save")) {
            try {
              let zz: zzdata = (this as any)['metadata']['configData'];
              this.createConfig(this.defaultWeight[0], this.flipWeight[0], this.somersaultWeight[0], this.isSequentialMode[0], zz.config_version, zz.config_file);
            } catch (error) {
              this.ModLoader.logger.error("There was an error saving the changes to the config file!")
              this.ModLoader.logger.error(error.message);
            }
          }

          
          if(this.ModLoader.ImGui.menuItem("Open Debug Window")) {
            this.debugWindowOpen = true;
          }
          

          this.ModLoader.ImGui.endMenu();
        }
        this.ModLoader.ImGui.endMenu();
      }
      this.ModLoader.ImGui.endMainMenuBar();
    }

    
    if(this.debugWindowOpen) {
      if(this.ModLoader.ImGui.begin("MM Jumps Debug", [this.debugWindowOpen])) {
        this.ModLoader.ImGui.text("Current Jump Selected: 0x" + this.getCurrentJumpString());
        this.ModLoader.ImGui.text("Current Link State: " + this.core.link.state);
        this.ModLoader.ImGui.text("Jump Heap Location: 0x" + this.myAlloc.pointer.toString(16));
        this.ModLoader.ImGui.text("Name Heap Location: 0x" + this.myNamePtr.toString(16));
        this.ModLoader.ImGui.text("Jump Flip Heap Location: 0x" + this.jumpFlipDataPtr.toString(16));
        this.ModLoader.ImGui.text("Jump Somersault Heap Location: 0x" + this.jumpSomersaultDataPtr.toString(16));
        this.ModLoader.ImGui.end();
      }
    }
    
  }

  addSlider(menuItemName: string, sliderID: string, numberRef: number[]): void {
    if (this.ModLoader.ImGui.beginMenu(menuItemName)) {
      if (this.ModLoader.ImGui.sliderInt(sliderID, numberRef, SLIDER_RANGE.MIN, SLIDER_RANGE.MAX)) {
        this.jumpNeedsUpdate = true;
      }
      this.ModLoader.ImGui.endMenu();
    }
  }
}

module.exports = main;
