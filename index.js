const { Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ChannelType, PermissionsBitField, StringSelectMenuBuilder, RoleSelectMenuBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

const TOKEN = process.env.TOKEN;
const TICKET_CATEGORY_ID = process.env.CATEGORY_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const MAIN_SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID;

// Ścieżka do pliku z danymi
const DATA_FILE = path.join(__dirname, 'bot_data.json');

// === FUNKCJE ZAPISU / ODCZYTU ===
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      return {
        supportRoles: new Set(data.supportRoles || []),
        ticketCategories: new Map(Object.entries(data.ticketCategories || {})),
        claimedTickets: new Map(Object.entries(data.claimedTickets || {}))
      };
    }
  } catch (err) {
    console.error('Błąd wczytywania danych:', err);
  }
  return {
    supportRoles: new Set(),
    ticketCategories: new Map(),
    claimedTickets: new Map()
  };
}

function saveData() {
  try {
    const data = {
      supportRoles: Array.from(supportRoles),
      ticketCategories: Object.fromEntries(ticketCategories),
      claimedTickets: Object.fromEntries(claimedTickets)
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Błąd zapisu danych:', err);
  }
}

// Wczytaj dane przy starcie
const savedData = loadData();
const supportRoles = savedData.supportRoles;
const ticketCategories = savedData.ticketCategories;
const claimedTickets = savedData.claimedTickets;

// === FUNKCJE POMOCNICZE ===
function getAllSupportRoleIds() {
  const roles = new Set();
  if (MAIN_SUPPORT_ROLE_ID) roles.add(MAIN_SUPPORT_ROLE_ID);
  for (const roleId of supportRoles) {
    roles.add(roleId);
  }
  return roles;
}

function hasSupportRole(member) {
  const allRoles = getAllSupportRoleIds();
  for (const roleId of allRoles) {
    if (member.roles.cache.has(roleId)) return true;
  }
  return member.permissions.has(PermissionsBitField.Flags.Administrator);
}

async function updateChannelPermissionsAfterClaim(channel, claimedUserId) {
  const allSupportRoleIds = getAllSupportRoleIds();
  const ticketAuthorId = channel.name.split('-').pop();

  const currentOverwrites = channel.permissionOverwrites.cache;
  for (const [id] of currentOverwrites) {
    if (allSupportRoleIds.has(id)) {
      await channel.permissionOverwrites.cache.get(id).delete().catch(() => {});
    }
  }

  for (const roleId of allSupportRoleIds) {
    await channel.permissionOverwrites.create(roleId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false
    });
  }

  if (claimedUserId !== ticketAuthorId) {
    const existingOverride = channel.permissionOverwrites.cache.get(claimedUserId);
    if (!existingOverride) {
      await channel.permissionOverwrites.create(claimedUserId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      });
    } else {
      await existingOverride.edit({
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      });
    }
  }

  const authorOverride = channel.permissionOverwrites.cache.get(ticketAuthorId);
  if (authorOverride) {
    await authorOverride.edit({
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    });
  }
}

client.once('ready', async () => {
  console.log(`Bot ${client.user.tag} jest online!`);
  console.log(`Wczytano ${ticketCategories.size} kategorii, ${supportRoles.size} dodatkowych ról, ${claimedTickets.size} claimniętych ticketów`);

  const commands = [
    {
      name: 'panel',
      description: 'Panel zarządzania kategoriami ticketów i rolami',
    },
    {
      name: 'ustaw-panel',
      description: 'Wyślij panel ticketowy na ten kanał',
    },
    {
      name: 'odswiez-panel',
      description: 'Odśwież panel ticketowy na tym kanale',
    },
    {
      name: 'claim',
      description: 'Przejmij ticket (tylko support)',
    },
    {
      name: 'dodajosobe',
      description: 'Dodaj osobę do ticketa',
      options: [
        {
          type: 6,
          name: 'uzytkownik',
          description: 'Osoba do dodania do ticketa',
          required: true
        }
      ]
    },
    {
      name: 'close',
      description: 'Zamknij ticket',
    }
  ];

  await client.application.commands.set(commands);
  console.log('Komendy slash zostały zarejestrowane!');
});

// === KOMENDA /USTAW-PANEL ===
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  if (interaction.commandName !== 'ustaw-panel') return;

  if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return interaction.reply({ content: '❌ Tylko administrator!', ephemeral: true });
  }

  await sendTicketPanel(interaction.channel);
  await interaction.reply({ content: '✅ Panel ticketowy został wysłany na ten kanał!', ephemeral: true });
});

// === KOMENDA /ODSWIEZ-PANEL ===
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  if (interaction.commandName !== 'odswiez-panel') return;

  if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return interaction.reply({ content: '❌ Tylko administrator!', ephemeral: true });
  }

  const messages = await interaction.channel.messages.fetch({ limit: 20 });
  const botMessages = messages.filter(m => m.author.id === client.user.id && m.components.length > 0);
  for (const msg of botMessages.values()) {
    await msg.delete().catch(() => {});
  }

  await sendTicketPanel(interaction.channel);
  await interaction.reply({ content: '✅ Panel został odświeżony!', ephemeral: true });
});

// === FUNKCJA WYSYŁANIA PANELU ===
async function sendTicketPanel(channel) {
  const categories = Array.from(ticketCategories.entries());

  if (categories.length === 0) {
    const embed = new EmbedBuilder()
      .setTitle('🎫 System Ticketowy')
      .setDescription('Kliknij przycisk poniżej, aby otworzyć ticket.')
      .setColor(0x5865F2)
      .setFooter({ text: 'Admin: użyj /panel aby dodać kategorie' });

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('create_ticket_general')
          .setLabel('📩 Otwórz Ticket')
          .setStyle(ButtonStyle.Primary)
      );

    return channel.send({ embeds: [embed], components: [row] });
  }

  const embed = new EmbedBuilder()
    .setTitle('🎫 System Ticketowy')
    .setDescription('Wybierz kategorię ticketu z menu poniżej:')
    .setColor(0x5865F2)
    .setFooter({ text: 'Wybierz temat i kliknij - bot utworzy ticket' });

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('ticket_category_select')
    .setPlaceholder('📋 Wybierz kategorię ticketu...');

  for (const [name, data] of categories) {
    selectMenu.addOptions({
      label: data.label,
      description: data.description || `Otwórz ticket: ${data.label}`,
      value: name,
      emoji: data.emoji || '📩'
    });
  }

  const row = new ActionRowBuilder().addComponents(selectMenu);
  await channel.send({ embeds: [embed], components: [row] });
}

// === KOMENDA /PANEL ===
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  if (interaction.commandName !== 'panel') return;

  if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return interaction.reply({ content: '❌ Tylko administrator może zarządzać ustawieniami!', ephemeral: true });
  }

  let rolesDesc = '';
  const allRoles = getAllSupportRoleIds();
  if (allRoles.size === 0) {
    rolesDesc = 'Brak ról supportu (sprawdź zmienną SUPPORT_ROLE_ID w env)';
  } else {
    for (const roleId of allRoles) {
      const role = interaction.guild.roles.cache.get(roleId);
      if (roleId === MAIN_SUPPORT_ROLE_ID) {
        rolesDesc += `👑 ${role ? role.name : 'Nieznana rola'} (główna - env)\n`;
      } else {
        rolesDesc += `🔹 ${role ? role.name : 'Nieznana rola'}\n`;
      }
    }
  }

  const embed = new EmbedBuilder()
    .setTitle('⚙️ Panel Zarządzania')
    .setDescription('Wybierz sekcję:')
    .addFields(
      { name: '📂 Kategorie ticketów', value: 'Dodawanie, usuwanie i lista kategorii', inline: true },
      { name: '👥 Role supportu', value: `Aktualne role:\n${rolesDesc}`, inline: false }
    )
    .setColor(0x5865F2);

  const row1 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('add_category')
        .setLabel('➕ Dodaj kategorię')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('remove_category')
        .setLabel('🗑️ Usuń kategorię')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('list_categories')
        .setLabel('📋 Lista kategorii')
        .setStyle(ButtonStyle.Secondary)
    );

  const row2 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('add_support_role')
        .setLabel('👑 Dodaj rolę supportu')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('remove_support_role')
        .setLabel('🗑️ Usuń rolę supportu')
        .setStyle(ButtonStyle.Danger)
    );

  await interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true });
});

// === OBSŁUGA PRZYCISKÓW PANELU ===
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!['add_category', 'remove_category', 'list_categories', 'add_support_role', 'remove_support_role'].includes(interaction.customId)) return;

  // === DODAJ KATEGORIĘ ===
  if (interaction.customId === 'add_category') {
    const embed = new EmbedBuilder()
      .setTitle('➕ Dodawanie nowej kategorii')
      .setDescription('Podaj **nazwę** kategorii (np. `Pomoc Techniczna`, `Zgłoś Gracza`):\n\nOdpowiedz w ciągu 30 sekund.')
      .setColor(0x57F287);

    await interaction.reply({ embeds: [embed], ephemeral: true });

    const filter = m => m.author.id === interaction.user.id;
    const collector = interaction.channel.createMessageCollector({ filter, time: 30000, max: 1 });

    collector.on('collect', async msg => {
      const rawName = msg.content.trim();
      const categoryKey = rawName.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_ąćęłńóśźż]/g, '').substring(0, 30);

      if (!categoryKey) {
        await interaction.followUp({ content: '❌ Nieprawidłowa nazwa!', ephemeral: true });
        return;
      }

      if (ticketCategories.has(categoryKey)) {
        await interaction.followUp({ content: '❌ Kategoria o tej nazwie już istnieje!', ephemeral: true });
        return;
      }

      ticketCategories.set(categoryKey, {
        label: rawName,
        description: `Ticket: ${rawName}`,
        emoji: '📩',
        channelName: `ticket-${categoryKey}`
      });

      saveData(); // <<< ZAPIS

      await msg.delete().catch(() => {});
      await interaction.followUp({
        content: `✅ Dodano kategorię: **${rawName}**\n\nTeraz użyj **/odswiez-panel** na kanale z panelem.`,
        ephemeral: true
      });

      if (LOG_CHANNEL_ID) {
        const logChannel = interaction.guild.channels.cache.get(LOG_CHANNEL_ID);
        if (logChannel) logChannel.send(`📝 Nowa kategoria: **${rawName}** (${interaction.user.tag})`);
      }
    });

    collector.on('end', collected => {
      if (collected.size === 0) {
        interaction.followUp({ content: '⏰ Upłynął czas.', ephemeral: true });
      }
    });
  }

  // === LISTA KATEGORII ===
  if (interaction.customId === 'list_categories') {
    const categories = Array.from(ticketCategories.entries());

    if (categories.length === 0) {
      return interaction.reply({ content: '📋 Brak zdefiniowanych kategorii.', ephemeral: true });
    }

    let desc = '';
    for (const [, data] of categories) {
      desc += `${data.emoji || '📩'} **${data.label}**\n`;
    }

    const embed = new EmbedBuilder()
      .setTitle('📋 Lista kategorii ticketów')
      .setDescription(desc)
      .setColor(0x5865F2);

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // === USUŃ KATEGORIĘ ===
  if (interaction.customId === 'remove_category') {
    const categories = Array.from(ticketCategories.entries());

    if (categories.length === 0) {
      return interaction.reply({ content: '❌ Brak kategorii do usunięcia.', ephemeral: true });
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('remove_category_select')
      .setPlaceholder('Wybierz kategorię do usunięcia...');

    for (const [name, data] of categories) {
      selectMenu.addOptions({
        label: data.label,
        description: `Usuń ${data.label}`,
        value: name,
        emoji: data.emoji || '📩'
      });
    }

    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.reply({ content: 'Wybierz kategorię do usunięcia:', components: [row], ephemeral: true });
  }

  // === DODAJ ROLĘ SUPPORTU ===
  if (interaction.customId === 'add_support_role') {
    const embed = new EmbedBuilder()
      .setTitle('👑 Dodawanie roli supportu')
      .setDescription('Wybierz rolę z menu poniżej.')
      .setColor(0x5865F2);

    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId('add_role_select')
      .setPlaceholder('Wybierz rolę do dodania...')
      .setMinValues(1)
      .setMaxValues(1);

    const row = new ActionRowBuilder().addComponents(roleSelect);
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  }

  // === USUŃ ROLĘ SUPPORTU ===
  if (interaction.customId === 'remove_support_role') {
    if (supportRoles.size === 0) {
      return interaction.reply({ content: '❌ Brak dodatkowych ról supportu do usunięcia.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('🗑️ Usuwanie roli supportu')
      .setDescription('Wybierz rolę do usunięcia:')
      .setColor(0xED4245);

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('remove_role_select')
      .setPlaceholder('Wybierz rolę do usunięcia...');

    for (const roleId of supportRoles) {
      const role = interaction.guild.roles.cache.get(roleId);
      selectMenu.addOptions({
        label: role ? role.name : 'Nieznana rola',
        description: `Usuń tę rolę z supportu`,
        value: roleId,
        emoji: '🗑️'
      });
    }

    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  }
});

// === OBSŁUGA SELECT MENU (DODAWANIE ROLI) ===
client.on('interactionCreate', async interaction => {
  if (!interaction.isRoleSelectMenu()) return;
  if (interaction.customId !== 'add_role_select') return;

  const roleId = interaction.values[0];
  const role = interaction.guild.roles.cache.get(roleId);

  if (!role) {
    return interaction.reply({ content: '❌ Nie znaleziono tej roli.', ephemeral: true });
  }

  if (roleId === MAIN_SUPPORT_ROLE_ID) {
    return interaction.reply({ content: '❌ Główna rola supportu (z env) już ma dostęp!', ephemeral: true });
  }

  if (supportRoles.has(roleId)) {
    return interaction.reply({ content: `❌ Rola **${role.name}** już jest dodana!`, ephemeral: true });
  }

  supportRoles.add(roleId);
  saveData(); // <<< ZAPIS

  // Zaktualizuj istniejące tickety
  const ticketChannels = interaction.guild.channels.cache.filter(
    ch => ch.name.includes('ticket-') && ch.type === ChannelType.GuildText
  );

  for (const [, channel] of ticketChannels) {
    if (claimedTickets.has(channel.id)) {
      await channel.permissionOverwrites.create(roleId, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: false
      }).catch(() => {});
    } else {
      await channel.permissionOverwrites.create(roleId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      }).catch(() => {});
    }
  }

  await interaction.reply({ content: `✅ Rola **${role.name}** została dodana do supportu!`, ephemeral: true });

  if (LOG_CHANNEL_ID) {
    const logChannel = interaction.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (logChannel) logChannel.send(`👑 ${interaction.user.tag} dodał rolę **${role.name}** do supportu`);
  }
});

// === OBSŁUGA SELECT MENU (USUWANIE ROLI) ===
client.on('interactionCreate', async interaction => {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== 'remove_role_select') return;

  const roleId = interaction.values[0];
  const role = interaction.guild.roles.cache.get(roleId);

  supportRoles.delete(roleId);
  saveData(); // <<< ZAPIS

  const ticketChannels = interaction.guild.channels.cache.filter(
    ch => ch.name.includes('ticket-') && ch.type === ChannelType.GuildText
  );

  for (const [, channel] of ticketChannels) {
    const overwrite = channel.permissionOverwrites.cache.get(roleId);
    if (overwrite) {
      await overwrite.delete().catch(() => {});
    }
  }

  await interaction.reply({ content: `✅ Rola **${role ? role.name : 'Nieznana'}** została usunięta z supportu.`, ephemeral: true });

  if (LOG_CHANNEL_ID) {
    const logChannel = interaction.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (logChannel) logChannel.send(`🗑️ ${interaction.user.tag} usunął rolę **${role ? role.name : 'Nieznana'}** z supportu`);
  }
});

// === OBSŁUGA SELECT MENU (USUWANIE KATEGORII) ===
client.on('interactionCreate', async interaction => {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== 'remove_category_select') return;

  const categoryName = interaction.values[0];
  const categoryData = ticketCategories.get(categoryName);

  if (!categoryData) {
    return interaction.reply({ content: '❌ Kategoria już nie istnieje.', ephemeral: true });
  }

  const embed = new EmbedBuilder()
    .setTitle('🗑️ Potwierdź usunięcie')
    .setDescription(`Czy na pewno chcesz usunąć kategorię **${categoryData.label}**?`)
    .setColor(0xED4245);

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_remove_${categoryName}`)
        .setLabel('✅ Tak, usuń')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('cancel_remove')
        .setLabel('❌ Anuluj')
        .setStyle(ButtonStyle.Secondary)
    );

  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
});

// === POTWIERDZENIE USUNIĘCIA KATEGORII ===
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('confirm_remove_') && interaction.customId !== 'cancel_remove') return;

  if (interaction.customId === 'cancel_remove') {
    return interaction.reply({ content: '✅ Anulowano.', ephemeral: true });
  }

  const categoryName = interaction.customId.replace('confirm_remove_', '');
  const categoryData = ticketCategories.get(categoryName);

  if (!categoryData) {
    return interaction.reply({ content: '❌ Kategoria już nie istnieje.', ephemeral: true });
  }

  ticketCategories.delete(categoryName);
  saveData(); // <<< ZAPIS

  await interaction.reply({
    content: `✅ Usunięto kategorię: **${categoryData.label}**\n\nUżyj **/odswiez-panel** aby zaktualizować panel.`,
    ephemeral: true
  });

  if (LOG_CHANNEL_ID) {
    const logChannel = interaction.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (logChannel) logChannel.send(`🗑️ Usunięto kategorię: **${categ
